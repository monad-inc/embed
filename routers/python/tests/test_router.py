import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from monad_embed import EmbedConfig, MonadClient, Provision, embed_router


def _monad_handler(request: httpx.Request) -> httpx.Response:
    """Stands in for the Monad API — just the endpoints these tests hit."""
    m, p = request.method, request.url.path
    if m == "POST" and p == "/v3/sessions":
        return httpx.Response(200, json={"session_token": "tok", "expires_at": "2026-01-01T00:00:00Z"})
    if m == "GET" and p == "/v1/inputs":
        return httpx.Response(
            200,
            json=[
                {"type_id": "aws-cloudtrail", "name": "AWS"},
                {"type_id": "secret", "name": "Hidden"},
            ],
        )
    if m == "POST" and p == "/v2/org_1/outputs":
        return httpx.Response(200, json={"id": "out_devnull"})
    if m == "POST" and p == "/v2/org_1/pipelines/":
        return httpx.Response(200, json={"id": "pipe_1"})
    if m == "GET" and p == "/v2/org_1/pipelines/pipe_1/status":
        return httpx.Response(200, json={"status": "Running"})
    return httpx.Response(500, json={"error": f"unmocked {m} {p}"})


def make_client(over=None, resolve=lambda req: "org_1") -> TestClient:
    cfg = EmbedConfig(
        api_key="k",
        api_base="http://monad",
        frame_origin="https://app.monad.com/embed",
        get_customer_org_id=resolve,
    )
    if over:
        over(cfg)
    mc = MonadClient("k", "http://monad", transport=httpx.MockTransport(_monad_handler))
    app = FastAPI()
    app.include_router(embed_router(cfg, monad_client=mc), prefix="/embed")
    return TestClient(app)


def test_get_config():
    res = make_client(resolve=lambda req: (_ for _ in ()).throw(AssertionError("no auth"))).get(
        "/embed/config"
    )
    assert res.status_code == 200
    assert res.json() == {"frameOrigin": "https://app.monad.com/embed", "apiBase": "http://monad"}


def test_config_defaults():
    # api_base + frame_origin omitted → production defaults.
    cfg = EmbedConfig(api_key="k", get_customer_org_id=lambda req: "org_1")
    app = FastAPI()
    app.include_router(embed_router(cfg), prefix="/embed")
    res = TestClient(app).get("/embed/config")
    assert res.json() == {
        "frameOrigin": "https://app.monad.com/embed",
        "apiBase": "https://app.monad.com/api",
    }


def test_session():
    res = make_client().post("/embed/session")
    assert res.status_code == 200
    assert res.json() == {
        "sessionToken": "tok",
        "organizationId": "org_1",
        "expiresAt": "2026-01-01T00:00:00Z",
    }


def test_catalog_allow_list():
    res = make_client(over=lambda c: setattr(c, "catalog_allow", ["aws-cloudtrail"])).get(
        "/embed/catalog?kind=input"
    )
    assert res.status_code == 200
    assert res.json() == [{"typeId": "aws-cloudtrail", "name": "AWS"}]


def test_ingress_dev_null():
    res = make_client().post("/embed/pipelines/ingress", json={"inputId": "in_1", "name": "CT"})
    assert res.status_code == 201
    body = res.json()
    assert body["outputId"] == "out_devnull"
    assert body["active"] is True


def test_ingress_store():
    res = make_client(over=lambda c: setattr(c, "get_provisioned_components", lambda org: Provision(destination_output_id="out_store"))).post(
        "/embed/pipelines/ingress", json={"inputId": "in_1", "name": "CT"}
    )
    assert res.status_code == 201
    assert res.json()["outputId"] == "out_store"


def test_egress_without_source_500s():
    res = make_client().post("/embed/pipelines/egress", json={"outputId": "out_1", "name": "Splunk"})
    assert res.status_code == 500
    assert res.json()["code"] == "internal_error"


def test_unauthenticated():
    res = make_client(resolve=lambda req: "").post("/embed/session")
    assert res.status_code == 401
    assert res.json()["code"] == "unauthenticated"


def test_invalid_kind():
    res = make_client().get("/embed/catalog?kind=nope")
    assert res.status_code == 400
    assert res.json()["code"] == "invalid_request"


def test_missing_body_field():
    res = make_client().post("/embed/pipelines/ingress", json={"name": "x"})
    assert res.status_code == 400


def test_not_found():
    res = make_client().get("/embed/nope")
    assert res.status_code == 404


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
