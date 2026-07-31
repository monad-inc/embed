"""Stateful scenario conformance — the lifecycle Schemathesis's stateless
fuzzing won't cover: mint → build → status → disable → status → remove → status.

Runs against whichever router the ``servers`` fixture booted, over HTTP, so it
is identical for every language.
"""

import os

import httpx
import pytest

_BASE_URL = os.environ.get("ROUTER_BASE_URL", "http://127.0.0.1:8791")


@pytest.fixture()
def client():
    with httpx.Client(base_url=_BASE_URL, timeout=15) as c:
        yield c


def test_config_is_public(client):
    r = client.get("/embed/config")
    assert r.status_code == 200
    body = r.json()
    assert body["frameOrigin"] == "https://app.monad.com/embed"
    assert "apiBase" in body


def test_ingress_lifecycle(client):
    # 1) mint a session for the resolved tenant
    r = client.post("/embed/session")
    assert r.status_code == 200, r.text
    assert r.json()["organizationId"] == "org_conf"

    # 2) the iframe returned an input id → build the ingress pipeline
    r = client.post("/embed/pipelines/ingress", json={"inputId": "in_conf", "name": "CloudTrail"})
    assert r.status_code == 201, r.text
    built = r.json()
    pipeline_id = built["pipelineId"]
    assert built["outputId"] == "out_store"  # wired to the provisioned store
    assert built["active"] is True

    # 3) status resolves the pipeline from the input id
    r = client.get("/embed/pipelines", params={"connectorId": "in_conf", "kind": "input"})
    assert r.status_code == 200, r.text
    status = r.json()
    assert status["hasPipeline"] is True
    assert status["pipelineId"] == pipeline_id
    assert status["outputId"] == "out_store"
    assert status["enabled"] is True

    # 4) disable — stops flow without deleting config
    r = client.post("/embed/pipelines/state", json={"pipelineId": pipeline_id, "enabled": False})
    assert r.status_code == 204, r.text

    r = client.get("/embed/pipelines", params={"connectorId": "in_conf", "kind": "input"})
    assert r.json()["enabled"] is False

    # 5) remove — the provisioned store is kept, the pipeline + input are gone
    r = client.post("/embed/pipelines/remove", json={"connectorId": "in_conf", "kind": "input"})
    assert r.status_code == 204, r.text

    r = client.get("/embed/pipelines", params={"connectorId": "in_conf", "kind": "input"})
    assert r.json()["hasPipeline"] is False


def test_egress_builds_from_provisioned_source(client):
    # the iframe returned an output id → wire the tenant's source → it
    r = client.post("/embed/pipelines/egress", json={"outputId": "out_conf", "name": "Splunk"})
    assert r.status_code == 201, r.text
    assert r.json()["outputId"] == "out_conf"


def test_catalog_is_allow_listed(client):
    r = client.get("/embed/catalog", params={"kind": "input"})
    assert r.status_code == 200
    type_ids = {t["typeId"] for t in r.json()}
    assert type_ids == {"aws-cloudtrail", "okta-systemlog"}


# Every route that takes `kind` must reject an invalid value with the shared
# error model — not just /catalog. (Schemathesis only ever sends enum-valid
# `kind`s, so this negative case has to be asserted explicitly.)
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
    # the router must translate Monad's 404, not fold it into a generic 502.
    r = client.post(
        "/embed/pipelines/state",
        json={"pipelineId": "pipe_does_not_exist", "enabled": False},
    )
    assert r.status_code == 404, r.text
    assert r.json()["code"] == "not_found"


def test_duplicate_ingress_conflicts(client):
    # Connecting the same source twice collides with existing state → 409 conflict
    # (a known Monad constraint the router must surface as the contract's `conflict`).
    body = {"inputId": "in_dup_conflict", "name": "Dup Conflict Test"}
    first = client.post("/embed/pipelines/ingress", json=body)
    assert first.status_code == 201, first.text
    second = client.post("/embed/pipelines/ingress", json=body)
    assert second.status_code == 409, second.text
    assert second.json()["code"] == "conflict"
