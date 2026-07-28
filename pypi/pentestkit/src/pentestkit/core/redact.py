SECRET_KEYS = {
    "authorization",
    "cookie",
    "password",
    "token",
    "api_key",
    "apikey",
    "secret",
    "jwt",
    "session",
}


def _is_secret_key(key) -> bool:
    normalized = str(key or "").lower().replace("-", "_")
    return any(part in normalized for part in SECRET_KEYS)


def redact(value):
    if isinstance(value, dict):
        out = {}
        for key, nested in value.items():
            out[key] = "[REDACTED]" if _is_secret_key(key) else redact(nested)
        return out
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value
