"""The mountable ``/embed`` FastAPI router."""

from __future__ import annotations

import functools
import inspect
import logging
from typing import Any, Awaitable, Callable, Optional

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse
from starlette.requests import Request

from .client import MonadClient, _seg
from .config import EmbedConfig, Provision
from .errors import EmbedError, MonadError
from .models import ConfigResponse

logger = logging.getLogger("monad_embed")


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"code": code, "message": message})


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _resolve(config: EmbedConfig, request: Request) -> str:
    try:
        org = await _maybe_await(config.get_customer_org_id(request))
    except EmbedError:
        raise
    except Exception as exc:  # noqa: BLE001 — any resolver failure means "not authenticated"
        raise EmbedError(
            401, "unauthenticated", "Could not resolve a tenant for the request."
        ) from exc
    if not org:
        raise EmbedError(401, "unauthenticated", "Could not resolve a tenant for the request.")
    return org


async def _provision(config: EmbedConfig, org: str) -> Provision:
    if config.get_provisioned_components is None:
        return Provision()
    return await _maybe_await(config.get_provisioned_components(org))


def _require_kind(value: Optional[str]) -> str:
    if value not in ("input", "output"):
        raise EmbedError(400, "invalid_request", "'kind' must be 'input' or 'output'.")
    return value


def _require_str(body: Any, field: str) -> str:
    value = body.get(field) if isinstance(body, dict) else None
    if not isinstance(value, str) or not value:
        raise EmbedError(400, "invalid_request", f"Field '{field}' is required.")
    return value


async def _json_body(request: Request) -> Any:
    try:
        return await request.json()
    except Exception:  # noqa: BLE001 — malformed/empty body → validated below
        return None


def _guard(
    fn: Callable[[Request], Awaitable[Response]],
) -> Callable[[Request], Awaitable[Response]]:
    """Wrap a route so every failure returns the contract's uniform error body."""

    @functools.wraps(fn)
    async def wrapper(request: Request) -> Response:
        try:
            return await fn(request)
        except EmbedError as exc:
            return _error(exc.status, exc.code, exc.message)
        except MonadError as exc:
            # Translate Monad's own status codes into the contract's error model.
            if exc.status == 404:
                return _error(
                    404, "not_found", "The referenced connector or pipeline does not exist."
                )
            if exc.status == 409:
                return _error(409, "conflict", "The request conflicts with existing state.")
            # Anything else: log the detail server-side, return a generic 502.
            logger.error("upstream Monad API call failed: %s", exc)
            return _error(502, "upstream_error", "The upstream Monad API request failed.")
        except Exception:  # noqa: BLE001
            logger.exception("unexpected error handling embed request")
            return _error(500, "internal_error", "An unexpected error occurred.")

    return wrapper


def embed_router(
    config: EmbedConfig, *, monad_client: Optional[MonadClient] = None
) -> APIRouter:
    """Build the ``/embed`` router. Mount with ``app.include_router(router, prefix="/embed")``.

    ``monad_client`` is an injection hook (mainly for tests); by default one is
    built from ``config``.
    """
    client = monad_client or MonadClient(config.api_key, config.api_base)
    router = APIRouter()

    async def get_config(request: Request) -> Response:
        return JSONResponse(
            ConfigResponse(frameOrigin=config.frame_origin, apiBase=config.api_base).model_dump()
        )

    async def create_session(request: Request) -> Response:
        org = await _resolve(config, request)
        session = await client.mint_session(org)
        return JSONResponse(session.model_dump())

    async def list_catalog(request: Request) -> Response:
        await _resolve(config, request)
        kind = _require_kind(request.query_params.get("kind"))
        types = await client.list_catalog(kind, config.catalog_allow)
        return JSONResponse([t.model_dump() for t in types])

    async def list_connectors(request: Request) -> Response:
        org = await _resolve(config, request)
        kind = _require_kind(request.query_params.get("kind"))
        rows = await client.list_connectors(org, kind)
        return JSONResponse([r.model_dump() for r in rows])

    async def build_ingress(request: Request) -> Response:
        org = await _resolve(config, request)
        body = await _json_body(request)
        input_id = _require_str(body, "inputId")
        name = _require_str(body, "name")
        prov = await _provision(config, org)
        if prov.destination_output_id:
            built = await client.wire_pipeline(org, input_id, prov.destination_output_id, name)
        else:
            built = await client.build_dev_null(org, input_id, name)
        return JSONResponse(status_code=201, content=built.model_dump())

    async def build_egress(request: Request) -> Response:
        org = await _resolve(config, request)
        body = await _json_body(request)
        output_id = _require_str(body, "outputId")
        name = _require_str(body, "name")
        prov = await _provision(config, org)
        if not prov.source_input_id:
            raise EmbedError(
                500,
                "internal_error",
                "No source input is provisioned for this tenant; egress cannot be built.",
            )
        built = await client.wire_pipeline(org, prov.source_input_id, output_id, name)
        return JSONResponse(status_code=201, content=built.model_dump())

    async def get_pipeline_status(request: Request) -> Response:
        org = await _resolve(config, request)
        connector_id = request.query_params.get("connectorId")
        if not connector_id:
            raise EmbedError(400, "invalid_request", "Query 'connectorId' is required.")
        kind = _require_kind(request.query_params.get("kind"))
        if kind == "input":
            status = await client.status_by_input(org, connector_id)
        else:
            status = await client.find_by_output(org, connector_id)
        return JSONResponse(status.model_dump(exclude_none=True))

    async def set_pipeline_state(request: Request) -> Response:
        org = await _resolve(config, request)
        body = await _json_body(request)
        pipeline_id = _require_str(body, "pipelineId")
        enabled = body.get("enabled") if isinstance(body, dict) else None
        if not isinstance(enabled, bool):
            raise EmbedError(400, "invalid_request", "Field 'enabled' must be a boolean.")
        await client.set_enabled(org, pipeline_id, enabled)
        return Response(status_code=204)

    async def remove_integration(request: Request) -> Response:
        org = await _resolve(config, request)
        body = await _json_body(request)
        connector_id = _require_str(body, "connectorId")
        kind = _require_kind(body.get("kind") if isinstance(body, dict) else None)

        if kind == "input":
            status = await client.status_by_input(org, connector_id)
            prov = await _provision(config, org)
            keep_store = bool(
                prov.destination_output_id
                and status.outputId
                and prov.destination_output_id == status.outputId
            )
            if status.pipelineId:
                await client.delete(f"/v2/{_seg(org)}/pipelines/{_seg(status.pipelineId)}")
            await client.delete(f"/v1/{_seg(org)}/inputs/{_seg(connector_id)}")
            if status.outputId and not keep_store:
                await client.delete(f"/v1/{_seg(org)}/outputs/{_seg(status.outputId)}")
        else:
            status = await client.find_by_output(org, connector_id)
            if status.pipelineId:
                await client.delete(f"/v2/{_seg(org)}/pipelines/{_seg(status.pipelineId)}")
            # Keep the shared source input; remove only the user's output.
            await client.delete(f"/v1/{_seg(org)}/outputs/{_seg(connector_id)}")
        return Response(status_code=204)

    router.add_api_route("/config", _guard(get_config), methods=["GET"])
    router.add_api_route("/session", _guard(create_session), methods=["POST"])
    router.add_api_route("/catalog", _guard(list_catalog), methods=["GET"])
    router.add_api_route("/connectors", _guard(list_connectors), methods=["GET"])
    router.add_api_route("/pipelines/ingress", _guard(build_ingress), methods=["POST"])
    router.add_api_route("/pipelines/egress", _guard(build_egress), methods=["POST"])
    router.add_api_route("/pipelines", _guard(get_pipeline_status), methods=["GET"])
    router.add_api_route("/pipelines/state", _guard(set_pipeline_state), methods=["POST"])
    router.add_api_route("/pipelines/remove", _guard(remove_integration), methods=["POST"])
    return router
