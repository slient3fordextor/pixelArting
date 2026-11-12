"""OAuth resource-server verification using operator-pinned public signing keys.

Authorization/consent, PKCE and token issuance belong to the configured external
OAuth 2.1 server. This process never issues tokens or fetches URLs from tokens.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import jwt
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

READ = 'pixelart:read'
WRITE = 'pixelart:write'
GENERATE = 'pixelart:generate'
ADMIN = 'pixelart:admin'
ScopeName = Literal['pixelart:read', 'pixelart:write', 'pixelart:generate', 'pixelart:admin']


class Grant(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)
    projects: frozenset[str] = frozenset()
    scopes: frozenset[ScopeName] = frozenset({READ})
    calls_per_minute: int = Field(default=120, ge=1, le=10000)
    writes_per_minute: int = Field(default=30, ge=1, le=1000)

    @model_validator(mode='after')
    def read_scope(self):
        if READ not in self.scopes:
            raise ValueError('Each grant requires read scope')
        if '*' in self.projects:
            raise ValueError('Use admin scope for workspace-wide access')
        return self


class OAuthConfig(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)
    issuer: str
    resource: str
    workspace_id: str = Field(min_length=1, max_length=128, pattern=r'^[a-zA-Z0-9_.:-]+$')
    jwks_file: Path
    principals: dict[str, Grant] = Field(min_length=1, max_length=1000)
    max_token_lifetime: int = Field(default=3600, ge=60, le=86400)
    require_write_confirmation: bool = False

    @field_validator('issuer', 'resource')
    @classmethod
    def https_url(cls, value):
        parsed = urlsplit(value)
        if any(character.isspace() for character in value) or any(character in value for character in ('"', '\\')):
            raise ValueError('Invalid OAuth URL')
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('OAuth issuer and resource must be absolute HTTPS URLs')
        return value

    @field_validator('resource')
    @classmethod
    def resource_path(cls, value):
        if urlsplit(value).path != '/mcp':
            raise ValueError('Resource URL must end with /mcp')
        return value

    @classmethod
    def load(cls, path: Path):
        try:
            if path.stat().st_size > 256 * 1024:
                raise ValueError
            config = cls.model_validate_json(path.read_text(encoding='utf-8'))
            if not config.jwks_file.is_absolute():
                config = config.model_copy(update={'jwks_file': (path.parent / config.jwks_file).resolve()})
            return config
        except (OSError, ValueError):
            raise ValueError('Invalid OAuth configuration file') from None


class Principal:
    def __init__(self, subject: str, client_id: str, scopes: frozenset[str], grant: Grant):
        self.subject, self.client_id, self.scopes, self.grant = subject, client_id, scopes, grant

    @property
    def admin(self):
        return ADMIN in self.scopes

    @property
    def projects(self):
        return self.grant.projects

    @property
    def can_write(self):
        return WRITE in self.scopes

    def allows_project(self, project_id):
        return self.admin or (project_id is not None and project_id in self.projects)


def current_principal(config: OAuthConfig | None = None) -> Principal | None:
    if config is None:
        return None
    token = get_access_token()
    if (token is None or token.subject not in config.principals or token.resource != config.resource
            or (token.claims or {}).get('iss') != config.issuer
            or (token.claims or {}).get('workspace_id') != config.workspace_id):
        raise PermissionError('Authentication required')
    grant = config.principals[token.subject]
    return Principal(token.subject, token.client_id, frozenset(token.scopes) & grant.scopes, grant)


class PinnedJWTVerifier:
    def __init__(self, config: OAuthConfig):
        self.config = config
        try:
            if config.jwks_file.stat().st_size > 256 * 1024:
                raise ValueError
            raw = json.loads(config.jwks_file.read_text(encoding='utf-8'))
            keys = raw['keys']
            if not isinstance(keys, list) or not 1 <= len(keys) <= 32:
                raise ValueError
            self.keys = {}
            for item in keys:
                if any(name in item for name in ('d', 'p', 'q', 'k')):
                    raise ValueError  # Public verification keys only.
                kid, alg = item['kid'], item['alg']
                if not isinstance(kid, str) or not 1 <= len(kid) <= 128 or kid in self.keys:
                    raise ValueError
                if alg not in {'RS256', 'ES256'} or item.get('use', 'sig') != 'sig':
                    raise ValueError
                if 'key_ops' in item and item['key_ops'] != ['verify']:
                    raise ValueError
                key = jwt.PyJWK.from_dict(item)
                if alg == 'RS256' and (item.get('kty') != 'RSA' or key.key.key_size < 2048):
                    raise ValueError
                if alg == 'ES256' and (item.get('kty') != 'EC' or item.get('crv') != 'P-256'):
                    raise ValueError
                self.keys[kid] = (alg, key.key)
        except (OSError, ValueError, KeyError, TypeError, jwt.PyJWTError):
            raise ValueError('Invalid OAuth public signing keys') from None

    async def verify_token(self, token: str) -> AccessToken | None:
        if not isinstance(token, str) or len(token) > 16384:
            return None
        try:
            header = jwt.get_unverified_header(token)
            if header.get('typ') != 'at+jwt' or any(key in header for key in ('jku', 'x5u', 'crit')):
                return None
            alg, key = self.keys[header['kid']]
            if header.get('alg') != alg:
                return None
            claims = jwt.decode(token, key, algorithms=[alg], issuer=self.config.issuer, audience=self.config.resource,
                                options={'require': ['exp', 'iat', 'iss', 'aud', 'sub', 'client_id', 'workspace_id'], 'strict_aud': True})
            if claims['workspace_id'] != self.config.workspace_id:
                return None
            if any(type(claims[name]) is not int for name in ('exp', 'iat')):
                return None
            if not 0 < claims['exp'] - claims['iat'] <= self.config.max_token_lifetime:
                return None
            subject, client_id, scope = claims['sub'], claims['client_id'], claims.get('scope', '')
            if not isinstance(client_id, str) or not 1 <= len(client_id) <= 256 or not isinstance(scope, str):
                return None
            grant = self.config.principals.get(subject)
            if grant is None:
                return None
            scopes = set(scope.split()) & grant.scopes
            return AccessToken(token=token, client_id=client_id, subject=subject, scopes=sorted(scopes),
                               expires_at=claims['exp'], resource=self.config.resource,
                               claims={'iss': self.config.issuer, 'workspace_id': self.config.workspace_id})
        except (jwt.PyJWTError, KeyError, ValueError, TypeError):
            return None
