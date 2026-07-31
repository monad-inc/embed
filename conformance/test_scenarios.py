"""Stateful scenario conformance — the lifecycle Schemathesis's stateless
fuzzing won't cover: mint → build → status → disable → status → remove → status.

Runs against whichever router the ``servers`` fixture booted, over HTTP, so it
is identical for every language.

The fixture values are read from the **same env vars the conformance servers
read**, so the identical scenarios run two ways:

- **mock mode** (default) — the env vars are unset, so everything falls back to
  the in-memory mock's fixtures (``org_conf`` / ``out_store`` / ``in_conf`` …).
- **live mode** (``MONAD_LIVE=1``) — the env points the router at real Monad
  staging, and the expected values come from the real tenant. The read-path
  scenarios (config/session/catalog/connectors) run as-is — that is exactly the
  response-shape surface that has bitten us. The mutating lifecycle scenarios
  additionally require ``MONAD_LIVE_MUTATE=1`` + real ``CONF_INPUT_ID`` /
  ``CONF_OUTPUT_ID`` throwaway components, and clean up after themselves.
"""

import os

import httpx
import pytest

_BASE_URL = os.environ.get("ROUTER_BASE_URL", "http://127.0.0.1:8791")

LIVE = os.environ.get("MONAD_LIVE") == "1"
# Mutating scenarios against real Monad are opt-in (they create + delete real
# pipelines) and need throwaway components to wire.
MUTATE = os.environ.get("MONAD_LIVE_MUTATE") == "1"

# Expected values — mirror the conformance servers' env defaults.
ORG = os.environ.get("MONAD_ORG_ID", "org_conf")
STORE = os.environ.get("MONAD_STORE_ID", "out_store")  # ingress target; "" → dev/null sink
FRAME = os.environ.get("MONAD_FRAME_ORIGIN", "https://app.monad.com/embed")
# A real configured input/output to wire in the mutating lifecycle scenarios.
INPUT_ID = os.environ.get("CONF_INPUT_ID", "in_conf")
OUTPUT_ID = os.environ.get("CONF_OUTPUT_ID", "out_conf")
# The allow-list the catalog should be constrained to (empty → whole catalog).
_ALLOW = os.environ.get("MONAD_CATALOG_ALLOW", "aws-cloudtrail,okta-systemlog")
EXPECT_CATALOG = {s.strip() for s in _ALLOW.split(",") if s.strip()}

# Skip a mutating scenario in live mode unless it was explicitly opted into.
skip_mutation = pytest.mark.skipif(
    LIVE and not MUTATE,
    reason="mutating live scenario — set MONAD_LIVE_MUTATE=1 with throwaway CONF_INPUT_ID/CONF_OUTPUT_ID",
)


@pytest.fixture()
def client():
    with httpx.Client(base_url=_BASE_URL, timeout=30) as c:
        yield c


def test_config_is_public(client):
    r = client.get("/embed/config")
    assert r.status_code == 200
    body = r.json()
    assert body["frameOrigin"] == FRAME
    assert "apiBase" in body


def test_session_mints_for_tenant(client):
    r = client.post("/embed/session")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["organizationId"] == ORG
    assert body.get("sessionToken")  # a real (or mock) token was minted


def test_connectors_list_parses(client):
    # The response-shape surface that has bitten us live (null-when-empty +
    # a `pagination` sibling). It must parse into the contract array for both
    # kinds regardless of how many the tenant has.
    for kind in ("input", "output"):
        r = client.get("/embed/connectors", params={"kind": kind})
        assert r.status_code == 200, r.text
        rows = r.json()
        assert isinstance(rows, list)
        for row in rows:
            assert {"id", "typeId", "name"} <= row.keys()


def test_catalog_is_allow_listed(client):
    r = client.get("/embed/catalog", params={"kind": "input"})
    assert r.status_code == 200
    type_ids = {t["typeId"] for t in r.json()}
    assert type_ids, "catalog must not be empty"
    if EXPECT_CATALOG:
        # The allow-list must constrain the catalog to (a subset of) itself.
        assert type_ids <= EXPECT_CATALOG


@skip_mutation
def test_ingress_lifecycle(client):
    # 1) mint a session for the resolved tenant
    r = client.post("/embed/session")
    assert r.status_code == 200, r.text
    assert r.json()["organizationId"] == ORG

    # 2) the iframe returned an input id → build the ingress pipeline
    r = client.post("/embed/pipelines/ingress", json={"inputId": INPUT_ID, "name": "CloudTrail"})
    assert r.status_code == 201, r.text
    built = r.json()
    pipeline_id = built["pipelineId"]
    if STORE:
        assert built["outputId"] == STORE  # wired to the provisioned store
    else:
        assert built["outputId"]  # a dev/null sink was created
    assert built["active"] is True

    # 3) status resolves the pipeline from the input id
    r = client.get("/embed/pipelines", params={"connectorId": INPUT_ID, "kind": "input"})
    assert r.status_code == 200, r.text
    status = r.json()
    assert status["hasPipeline"] is True
    assert status["pipelineId"] == pipeline_id
    if STORE:
        assert status["outputId"] == STORE
    assert status["enabled"] is True

    # 4) disable — stops flow without deleting config
    r = client.post("/embed/pipelines/state", json={"pipelineId": pipeline_id, "enabled": False})
    assert r.status_code == 204, r.text

    r = client.get("/embed/pipelines", params={"connectorId": INPUT_ID, "kind": "input"})
    assert r.json()["enabled"] is False

    # 5) remove — the provisioned store is kept, the pipeline + input are gone
    r = client.post("/embed/pipelines/remove", json={"connectorId": INPUT_ID, "kind": "input"})
    assert r.status_code == 204, r.text

    r = client.get("/embed/pipelines", params={"connectorId": INPUT_ID, "kind": "input"})
    assert r.json()["hasPipeline"] is False


@skip_mutation
def test_egress_builds_from_provisioned_source(client):
    # the iframe returned an output id → wire the tenant's source → it
    r = client.post("/embed/pipelines/egress", json={"outputId": OUTPUT_ID, "name": "Splunk"})
    assert r.status_code == 201, r.text
    assert r.json()["outputId"] == OUTPUT_ID
    if LIVE:
        # clean up the pipeline (+ output) we just created; keep the shared source.
        client.post("/embed/pipelines/remove", json={"connectorId": OUTPUT_ID, "kind": "output"})


# Every route that takes `kind` must reject an invalid value with the shared
# error model — not just /catalog. (Schemathesis only ever sends enum-valid
# `kind`s, so this negative case has to be asserted explicitly.) Router-local
# validation, so it runs identically against mock and live.
@pytest.mark.parametrize(
    "call",
    [
        lambda c: c.get("/embed/catalog", params={"kind": "nope"}),
        lambda c: c.get("/embed/connectors", params={"kind": "nope"}),
        lambda c: c.get("/embed/pipelines", params={"connectorId": "in_x", "kind": "nope"}),
        lambda c: c.post("/embed/pipelines/remove", json={"connectorId": "in_x", "kind": "nope"}),
    ],
    ids=["catalog", "connectors", "pipelines", "remove"],
)
def test_invalid_kind_is_rejected(client, call):
    r = call(client)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "invalid_request"


def test_state_on_unknown_pipeline_is_404(client):
    # Toggling a pipeline that doesn't exist for this tenant is a 404 not_found —
    # the router must translate Monad's 404, not fold it into a generic 502. The
    # router reads the pipeline before writing, so this creates nothing → safe live.
    r = client.post(
        "/embed/pipelines/state",
        json={"pipelineId": "00000000-0000-4000-8000-000000000000", "enabled": False},
    )
    assert r.status_code == 404, r.text
    assert r.json()["code"] == "not_found"


@pytest.mark.skipif(
    LIVE,
    reason="Monad does not document a 409 on duplicate pipeline creation (201/400/500 only); "
    "the mock emulates the constraint, real behavior is asserted only hermetically",
)
def test_duplicate_ingress_conflicts(client):
    # Connecting the same source twice collides with existing state → 409 conflict
    # (a known Monad constraint the router must surface as the contract's `conflict`).
    body = {"inputId": "in_dup_conflict", "name": "Dup Conflict Test"}
    first = client.post("/embed/pipelines/ingress", json=body)
    assert first.status_code == 201, first.text
    second = client.post("/embed/pipelines/ingress", json=body)
    assert second.status_code == 409, second.text
    assert second.json()["code"] == "conflict"
