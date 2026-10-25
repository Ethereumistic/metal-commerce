"""Structured service errors shared by the API, worker and processing modules."""

from __future__ import annotations

from typing import Any

# Default HTTP status per error code; processing failures recorded on jobs reuse
# the same codes without an HTTP context.
HTTP_STATUS: dict[str, int] = {
    "UNAUTHORIZED": 401,
    "FORBIDDEN": 403,
    "NOT_FOUND": 404,
    "IDEMPOTENCY_CONFLICT": 409,
    "VALIDATION_ERROR": 422,
    "INVALID_DIMENSIONS": 422,
    "PART_DOES_NOT_FIT": 422,
    "MASTER_STALE": 409,
    "INSUFFICIENT_DISK": 507,
    "INTERNAL_ERROR": 500,
}


class ServiceError(Exception):
    """An actionable failure with a stable code from the contract."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None,
                 *, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}
        self.status = status or HTTP_STATUS.get(code, 400)

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details}


class InsufficientDisk(ServiceError):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__("INSUFFICIENT_DISK", message, details)


class JobCancelled(Exception):
    """Raised at a checkpoint when cancellation was requested for the running job."""


class JobTimeout(Exception):
    """Raised at a checkpoint when the job exceeded its configured run time."""
