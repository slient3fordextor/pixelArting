"""Standalone launcher. Parsing help/version does not import image or MCP runtimes."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

from ._version import SERVICE_VERSION


def default_data_root() -> Path:
    if sys.platform == "win32":
        parent = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        parent = Path.home() / "Library" / "Application Support"
    else:
        parent = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return parent / "pixelarting"


def main(argv: list[str] | None = None, *, legacy_data_root: Path | None = None) -> None:
    parser = argparse.ArgumentParser(description="PixelArting local MCP v1 (no desktop required)")
    parser.add_argument("--version", action="version", version=f"%(prog)s {SERVICE_VERSION}")
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("PIXELART_DATA_DIR", legacy_data_root or default_data_root())))
    parser.add_argument("--transport", choices=("stdio", "streamable-http", "sse"), default=os.environ.get("PIXELART_MCP_TRANSPORT", "stdio"))
    parser.add_argument("--host", default=os.environ.get("PIXELART_MCP_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=os.environ.get("PIXELART_MCP_PORT", "8765"))
    permissions = parser.add_mutually_exclusive_group()
    permissions.add_argument("--allow-write", dest="allow_write", action="store_true", help="Grant this local process permission to mutate its workspace")
    permissions.add_argument("--read-only", dest="allow_write", action="store_false", help="Disable writes even if the environment enables them")
    parser.set_defaults(allow_write=os.environ.get("PIXELART_MCP_ALLOW_WRITE", "").lower() in {"1", "true", "yes"})
    commands = parser.add_mutually_exclusive_group()
    commands.add_argument("--schema", action="store_true", help="Print discovered v1 tool/resource schemas as JSON, then exit without opening the database")
    commands.add_argument("--openapi", action="store_true", help="Print HTTP v1 OpenAPI 3.1 JSON, then exit without opening the database")
    commands.add_argument("--review-write", metavar="REQUEST_ID", help="Locally review an exact pending OAuth write; does not execute it")
    commands.add_argument("--approve-write", metavar="REQUEST_ID", help="Approve a reviewed write once; requires --approval-digest")
    commands.add_argument("--reject-write", metavar="REQUEST_ID", help="Reject a pending write or revoke an unused approval")
    parser.add_argument("--approval-digest", help="SHA-256 digest from --review-write, required for --approve-write")
    parser.add_argument("--oauth-config", type=Path, help="OAuth resource server configuration (Streamable HTTP only)")
    args = parser.parse_args(argv)
    if bool(args.approve_write) != bool(args.approval_digest):
        parser.error('--approve-write and --approval-digest must be supplied together')
    if args.review_write or args.approve_write or args.reject_write:
        from .mcp_approval import WriteApprovals, ApprovalUnavailable
        approvals = WriteApprovals(args.data_dir)
        try:
            if args.review_write:
                # JSON escapes terminal control characters, including bidi controls.
                print(json.dumps(approvals.review(args.review_write), indent=2, ensure_ascii=True))
            elif args.approve_write:
                approvals.approve(args.approve_write, args.approval_digest)
                print(json.dumps({'approved': args.approve_write, 'executed': False}))
            else:
                approvals.reject(args.reject_write)
                print(json.dumps({'rejected': args.reject_write, 'executed': False}))
        except (ValueError, ApprovalUnavailable) as error:
            parser.error(str(error))
        return
    if args.transport not in {"stdio", "streamable-http", "sse"}:
        parser.error("Unsupported MCP transport")

    from .mcp_server import create_mcp_server
    from .mcp_contract import CONTRACT_VERSION
    from .mcp_auth import OAuthConfig

    try:
        if args.oauth_config is not None and args.transport != 'streamable-http' and not (args.schema or args.openapi):
            parser.error('OAuth requires --transport streamable-http')
        oauth = OAuthConfig.load(args.oauth_config) if args.oauth_config else None
        server = create_mcp_server(args.data_dir, allow_write=args.allow_write, host=args.host, port=args.port, oauth=oauth)
    except ValueError as error:
        parser.error(str(error))

    if args.openapi:
        print(json.dumps(asyncio.run(server.openapi()), ensure_ascii=False, indent=2))
        return
    if args.schema:
        async def describe():
            return {
                "contractVersion": CONTRACT_VERSION,
                "serviceVersion": SERVICE_VERSION,
                "tools": [tool.model_dump(mode="json", exclude_none=True, by_alias=True) for tool in await server.list_tools()],
                "resources": [resource.model_dump(mode="json", exclude_none=True, by_alias=True) for resource in await server.list_resources()],
                "resourceTemplates": [template.model_dump(mode="json", exclude_none=True, by_alias=True) for template in await server.list_resource_templates()],
            }
        print(json.dumps(asyncio.run(describe()), ensure_ascii=False, indent=2))
        return
    server.run(transport=args.transport)


if __name__ == "__main__":
    main()
