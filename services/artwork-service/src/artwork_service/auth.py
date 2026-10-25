"""Service authentication, business scoping and idempotency.

The Metal Admin server is the only client. It authenticates with a shared
bearer token and asserts the business, actor and edit permission it verified
for the signed-in user. The service trusts those assertions only after the
token check, scopes every row by business, and requires edit permission and an
Idempotency-Key for every mutation.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Any

from fastapi import Request

from .errors import ServiceError
from .storage import Database, dumps, loads, utcnow

BUSINESS_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{8,200}$")


@dataclass(frozen=True)
class Context:
    business_id: str
    actor: str | None
    can_edit: bool


def authenticate(request: Request, token: str) -> Context:
    header = request.headers.get("authorization", "")
    scheme, _, supplied = header.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(supplied.strip().encode(), token.encode()):
        raise ServiceError("UNAUTHORIZED", "A valid service token is required.")
    business_id = request.headers.get("x-artwork-business-id", "")
    if not BUSINESS_ID_RE.match(business_id):
        raise ServiceError("UNAUTHORIZED", "A valid X-Artwork-Business-Id header is required.")
    actor = request.headers.get("x-artwork-actor") or None
    if actor is not None and len(actor) > 200:
        raise ServiceError("VALIDATION_ERROR", "X-Artwork-Actor is too long.")
    can_edit = request.headers.get("x-artwork-can-edit", "false").strip().lower() == "true"
    return Context(business_id=business_id, actor=actor, can_edit=can_edit)


def require_edit(ctx: Context) -> None:
    if not ctx.can_edit:
        raise ServiceError("FORBIDDEN", "Edit permission is required for this operation.")


def fingerprint(method: str, path: str, body: Any) -> str:
    canonical = json.dumps({"method": method, "path": path, "body": body}, sort_keys=True,
                           separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


@dataclass
class Replay:
    status_code: int
    body: Any


def idempotency_key(request: Request) -> str:
    key = request.headers.get("idempotency-key", "")
    if not IDEMPOTENCY_KEY_RE.match(key):
        raise ServiceError("VALIDATION_ERROR",
                           "An Idempotency-Key header (8-200 characters of A-Z a-z 0-9 _ . : -) is required.")
    return key


def reserve(db: Database, ctx: Context, key: str, fp: str) -> Replay | None:
    """Reserve the key for this request, or return the stored response to replay.

    Same key with a different fingerprint is a conflict; a key whose first
    request is still running is also a conflict (the client retries later).
    """
    with db.tx() as conn:
        row = conn.execute("SELECT * FROM idempotency_keys WHERE business_id = ? AND key = ?",
                           (ctx.business_id, key)).fetchone()
        if row is None:
            conn.execute("INSERT INTO idempotency_keys (business_id, key, fingerprint, created_at)"
                         " VALUES (?, ?, ?, ?)", (ctx.business_id, key, fp, utcnow()))
            return None
    if row["fingerprint"] != fp:
        raise ServiceError("IDEMPOTENCY_CONFLICT",
                           "This Idempotency-Key was already used for a different request.", {"key": key})
    if row["status_code"] is None:
        raise ServiceError("IDEMPOTENCY_CONFLICT",
                           "A request with this Idempotency-Key is still being processed; retry shortly.",
                           {"key": key, "in_progress": True})
    return Replay(row["status_code"], loads(row["response"]))


def store_response(conn: sqlite3.Connection, ctx: Context, key: str, status_code: int, body: Any) -> None:
    conn.execute("UPDATE idempotency_keys SET status_code = ?, response = ? WHERE business_id = ? AND key = ?",
                 (status_code, dumps(body), ctx.business_id, key))


def release(db: Database, ctx: Context, key: str) -> None:
    """Forget a reservation whose request failed unexpectedly so a retry can run."""
    with db.tx() as conn:
        conn.execute("DELETE FROM idempotency_keys WHERE business_id = ? AND key = ? AND status_code IS NULL",
                     (ctx.business_id, key))
