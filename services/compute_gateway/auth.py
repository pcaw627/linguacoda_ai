"""JWT validation for compute gateway remote mode."""

from __future__ import annotations

import os
from typing import Any

import jwt
from jwt.exceptions import InvalidTokenError

JWT_ALGORITHM = "HS256"


def remote_mode_enabled() -> bool:
    flag = os.environ.get("LINGUACODA_REMOTE_MODE", "").strip().lower()
    return flag in ("1", "true", "yes", "on")


def jwt_secret() -> str | None:
    secret = os.environ.get("JWT_SECRET", "").strip()
    return secret or None


def validate_compute_jwt(token: str) -> dict[str, Any]:
    secret = jwt_secret()
    if not secret:
        raise ValueError("JWT_SECRET is not configured")

    payload = jwt.decode(
        token,
        secret,
        algorithms=[JWT_ALGORITHM],
        options={"require": ["exp", "sub"]},
    )
    return payload


def extract_bearer_token(authorization_header: str | None) -> str | None:
    if not authorization_header or not authorization_header.startswith("Bearer "):
        return None
    token = authorization_header[7:].strip()
    return token or None


def authenticate_request(authorization_header: str | None, *, remote_mode: bool) -> tuple[dict[str, Any] | None, str | None]:
    if not remote_mode:
        return {"sub": "local"}, None

    token = extract_bearer_token(authorization_header)
    if not token:
        return None, "Missing Bearer token"

    try:
        return validate_compute_jwt(token), None
    except InvalidTokenError:
        return None, "Invalid or expired token"
    except ValueError as err:
        return None, str(err)
