# PixelArting agent instructions

When an MCP client exposes the `pixelarting` server, use it for PixelArting project, asset, version, and quality-check operations instead of editing `data/pixelart.sqlite3` directly.

Before a mutation, read the current asset with `get_asset(include_document=true)` and pass its `currentVersionId` to the write tool. After a mutation, call `inspect_asset` and report any findings. Respect the server's write gate and do not enable `PIXELART_MCP_ALLOW_WRITE=1` unless the user has requested agent edits.

For quality findings, prefer `preview_asset_repair`, review its `changes` and `report`, then call `commit_asset_repair`. Never commit a stale preview after the current version has changed.
