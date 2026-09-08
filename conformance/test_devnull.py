"""Dev/null ingress coverage — the no-provisioned-store path.

The main harness always provisions a destination store (MONAD_STORE_ID=out_store),
so a router's ``buildDevNull`` branch — create a /dev/null sink, then wire the
input to it — is never exercised there. This boots a SECOND router configured
with no store, pointed at the same mock, and drives one ingress through the
dev/null path.

Mock-only: in live mode we don't fabricate a no-store tenant.
"""

import os
import signal
import subprocess

import httpx
import pytest

# Reuse the harness's per-language boot machinery (cmd/cwd/env + health wait).
from conftest import _command, _wait_healthy

LIVE = os.environ.get("MONAD_LIVE") == "1"
_PORT = 8796  # distinct from the main router's ROUTER_PORT (8791)

pytestmark = pytest.mark.skipif(LIVE, reason="dev/null path is exercised in mock mode only")


@pytest.fixture(scope="module")
def devnull_base_url():
    cmd, cwd, env = _command()
    env = dict(env)
    env["MONAD_STORE_ID"] = ""  # no provisioned store → the router builds a dev/null sink
    env["PORT"] = str(_PORT)
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, start_new_session=True)
    try:
        if not _wait_healthy(f"http://127.0.0.1:{_PORT}/embed/config"):
            raise RuntimeError("no-store router did not become healthy")
        yield f"http://127.0.0.1:{_PORT}"
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass


def test_ingress_builds_devnull_sink(devnull_base_url):
    with httpx.Client(base_url=devnull_base_url, timeout=30) as c:
        r = c.post("/embed/pipelines/ingress", json={"inputId": "in_devnull", "name": "DevNull"})
        assert r.status_code == 201, r.text
        built = r.json()
        # A sink was auto-created (a fresh id, not one of the host's provisioned
        # stores) and the input wired to it.
        assert built["outputId"], "no output was created for the dev/null pipeline"
        assert built["outputId"] not in ("out_store", "out_conf")
        assert built["active"] is True
        # Clean up the pipeline + the auto-created sink.
        c.post("/embed/pipelines/remove", json={"connectorId": "in_devnull", "kind": "input"})
