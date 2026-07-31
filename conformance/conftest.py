"""Conformance harness fixtures.

Boots the stateful mock Monad plus the router under test (selected by the
``ROUTER`` env var: ``python`` | ``go`` | ``ts``), pointed at the mock, then
yields for the tests. Language-agnostic: every test drives the router over HTTP.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
import urllib.request

import pytest

import mock_monad

ROUTER = os.environ.get("ROUTER", "python")
MOCK_PORT = int(os.environ.get("MOCK_PORT", "8790"))
ROUTER_PORT = int(os.environ.get("ROUTER_PORT", "8791"))

# Live mode boots the router against the real Monad API (MONAD_API_BASE +
# MONAD_API_KEY + MONAD_ORG_ID … supplied by the caller) instead of the mock.
LIVE = os.environ.get("MONAD_LIVE") == "1"

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, ".."))


def _command() -> tuple[list[str], str, dict[str, str]]:
    env = dict(os.environ)
    # In mock mode we own MONAD_API_BASE (point the router at the local mock);
    # in live mode the caller's real MONAD_API_BASE is passed through untouched.
    if not LIVE:
        env["MONAD_API_BASE"] = f"http://127.0.0.1:{MOCK_PORT}"
    env["PORT"] = str(ROUTER_PORT)
    if ROUTER == "python":
        return [os.path.join(_HERE, ".venv", "bin", "python"), os.path.join(_HERE, "servers", "py_server.py")], _HERE, env
    if ROUTER == "go":
        return ["go", "run", "./cmd/conformance"], os.path.join(_REPO, "routers", "go"), env
    if ROUTER == "ts":
        return ["node", os.path.join(_HERE, "servers", "ts_server.mjs")], _HERE, env
    raise ValueError(f"unknown ROUTER={ROUTER!r} (expected python|go|ts)")


def _wait_healthy(url: str, timeout: float = 45.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                if resp.status < 500:
                    return True
        except Exception:  # noqa: BLE001 — server not up yet
            time.sleep(0.15)
    return False


@pytest.fixture(scope="session", autouse=True)
def servers():
    # Live mode talks to real Monad — no mock to boot.
    server = None if LIVE else mock_monad.start(MOCK_PORT)[0]
    cmd, cwd, env = _command()
    # New session so we can kill the whole group (e.g. `go run` + its child binary).
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, start_new_session=True)
    try:
        if not _wait_healthy(f"http://127.0.0.1:{ROUTER_PORT}/embed/config"):
            raise RuntimeError(f"router '{ROUTER}' did not become healthy on port {ROUTER_PORT}")
        yield
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
        if server is not None:
            server.shutdown()
