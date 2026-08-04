"""Pin the stateful mock to the documented Monad response shapes.

Boots its own mock instance and drives it exactly as the routers do, asserting
every response validates against the vendored Monad schemas (``monad_schemas``).
This is the hermetic complement to live conformance: live testing catches where
the *docs* are wrong (e.g. null-when-empty), while this catches the *mock*
drifting from the docs on a field a router parses — the class of gap that let
the missing ``pagination`` sibling ship. Fast, offline, no credentials.
"""

import httpx
import pytest
from jsonschema import Draft202012Validator

import mock_monad
import monad_schemas as S

_ORG = "org_conf"


@pytest.fixture(scope="module")
def base_url():
    # A dedicated mock instance on its own port — independent of the conftest
    # `servers` fixture (which also boots a router), so this stays hermetic in
    # both mock and live router modes.
    port = 8795
    server, _state = mock_monad.start(port)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()


@pytest.fixture()
def http(base_url):
    with httpx.Client(base_url=base_url, timeout=10) as c:
        yield c


def _valid(schema: dict, instance) -> None:
    errors = sorted(Draft202012Validator(schema).iter_errors(instance), key=lambda e: e.path)
    assert not errors, "; ".join(f"{list(e.path)}: {e.message}" for e in errors)


def test_session_shape(http):
    r = http.post("/v3/sessions", json={"organization_id": _ORG, "ttl_seconds": 1800})
    assert r.status_code == 200
    _valid(S.SESSION, r.json())


@pytest.mark.parametrize("kind", ["input", "output"])
def test_catalog_shape(http, kind):
    r = http.get(f"/v1/{kind}s")
    assert r.status_code == 200
    _valid(S.CATALOG, r.json())


@pytest.mark.parametrize("kind", ["input", "output"])
def test_connectors_list_shape(http, kind):
    # Covers both the populated (inputs) and the null-when-empty (outputs) case,
    # each of which must still carry the `pagination` sibling.
    r = http.get(f"/v1/{_ORG}/{kind}s?limit=1000&offset=0")
    assert r.status_code == 200
    _valid(S.connectors_list(kind), r.json())


def test_connectors_list_defaults_to_ten(http):
    # Monad's list handlers default `limit` to 10 with no maximum. A router that
    # omits it gets a truncated page — the mock must reproduce that, not paper
    # over it, or the "only ever sees 10" bug stays invisible until production.
    unpaged = http.get(f"/v1/{_ORG}/inputs").json()
    assert len(unpaged["inputs"]) == 10
    assert unpaged["pagination"] == {"limit": 10, "offset": 0, "total": mock_monad._SEEDED_INPUTS}

    rest = http.get(f"/v1/{_ORG}/inputs?limit=10&offset=10").json()
    assert len(rest["inputs"]) == mock_monad._SEEDED_INPUTS - 10
    # Past the end the list is null, not [] — the same shape as "tenant has none".
    assert http.get(f"/v1/{_ORG}/inputs?limit=10&offset=99").json()["inputs"] is None


@pytest.mark.parametrize("kind", ["input", "output"])
def test_connector_detail_shape(http, kind):
    cid = "in_conf" if kind == "input" else "out_store"
    r = http.get(f"/v1/{_ORG}/{kind}s/{cid}")
    assert r.status_code == 200, r.text
    _valid(S.connector_detail(kind), r.json())
    # Unconnected component → an empty `component_of`, not a missing key.
    assert r.json()["component_of"] == []
    assert http.get(f"/v1/{_ORG}/{kind}s/nope_404").status_code == 404


def test_connector_detail_reports_component_of(http):
    body = {
        "name": "component-of",
        "enabled": True,
        "nodes": [
            {"slug": "in", "component_id": "cfg_3", "component_type": "input", "enabled": True},
            {"slug": "out", "component_id": "out_store", "component_type": "output", "enabled": True},
        ],
        "edges": [],
    }
    pid = http.post(f"/v2/{_ORG}/pipelines/", json=body).json()["id"]
    for cid in ("cfg_3", "out_store"):
        kind = "inputs" if cid.startswith("cfg") else "outputs"
        entry = http.get(f"/v1/{_ORG}/{kind}/{cid}").json()["component_of"]
        assert [p["id"] for p in entry] == [pid]
        assert entry[0]["enabled"] is True
    http.delete(f"/v2/{_ORG}/pipelines/{pid}")


@pytest.mark.parametrize("field", ["type", "output_type"])
def test_output_create_shape(http, field):
    # `type` is canonical; `output_type` is the deprecated alias the API still
    # accepts. Both must round-trip to the same created record.
    r = http.post(f"/v2/{_ORG}/outputs", json={field: "dev-null", "name": "sink"})
    assert r.status_code == 200
    _valid(S.OUTPUT, r.json())
    assert r.json()["type"] == "dev-null"


def test_pipeline_lifecycle_shapes(http):
    body = {
        "name": "fidelity",
        "enabled": True,
        "nodes": [
            {"slug": "in", "component_id": "in_fidelity", "component_type": "input", "enabled": True},
            {"slug": "out", "component_id": "out_fidelity", "component_type": "output", "enabled": True},
        ],
        "edges": [],
    }
    created = http.post(f"/v2/{_ORG}/pipelines/", json=body)
    assert created.status_code == 201, created.text
    _valid(S.PIPELINE, created.json())
    pid = created.json()["id"]

    listed = http.get(f"/v2/{_ORG}/pipelines/")
    assert listed.status_code == 200
    _valid(S.PIPELINE_LIST, listed.json())

    detail = http.get(f"/v2/{_ORG}/pipelines/{pid}")
    assert detail.status_code == 200
    _valid(S.PIPELINE, detail.json())

    status = http.get(f"/v2/{_ORG}/pipelines/{pid}/status")
    assert status.status_code == 200
    _valid(S.PIPELINE_STATUS, status.json())

    patched = http.patch(f"/v2/{_ORG}/pipelines/{pid}", json={**body, "enabled": False})
    assert patched.status_code == 200
    _valid(S.PIPELINE, patched.json())
