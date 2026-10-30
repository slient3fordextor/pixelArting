"""Small adapter around the operating system credential store.

The optional dependency is deliberately isolated here so old installations can
still open their database while the runtime is being upgraded.
"""

try:
    import keyring as _keyring
except ImportError:  # pragma: no cover - exercised by minimal installations
    _keyring = None


class SecretStore:
    service = "PixelArting"

    def get(self, key: str) -> str | None:
        if _keyring is None:
            return None
        try:
            value = _keyring.get_password(self.service, key)
        except Exception:
            return None
        return value if isinstance(value, str) and value else None

    def set(self, key: str, value: str) -> bool:
        if _keyring is None:
            return False
        try:
            _keyring.set_password(self.service, key, value)
        except Exception:
            return False
        return True

    def delete(self, key: str) -> None:
        if _keyring is None:
            return
        try:
            _keyring.delete_password(self.service, key)
        except Exception:
            pass
