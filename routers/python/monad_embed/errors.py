"""Error types for the ``/embed`` router."""

from __future__ import annotations


class EmbedError(Exception):
    """An error carrying the HTTP status + stable code from the contract's error model."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class MonadError(Exception):
    """Raised by the Monad client on an API failure. Mapped to ``502 upstream_error``.

    Carries the upstream status + internal detail for server-side logging; the
    router surfaces only a generic message so the upstream response body never
    reaches the browser.
    """

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
