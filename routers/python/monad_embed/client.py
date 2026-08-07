"""The hand-written Monad API client — the Python equivalent of the TS kit.

Sequences Monad's /v1 + /v2 + /v3 calls; the router layer turns its results into
the ``/embed`` contract's responses. A failed call raises :class:`MonadError`,
which the router maps to ``502 upstream_error``.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional
from urllib.parse import quote

import httpx

from .errors import MonadError
from .models import (
    BuiltPipeline,
    CatalogType,
    ConfiguredConnector,
    PipelineStatus,
    Session,
)

_POLL_ATTEMPTS = 15
_POLL_INTERVAL = 2.0

# Rows per request when draining a Monad list. Monad defaults ``limit`` to 10
# and enforces no maximum, so this is a round-trip/response-size trade-off only:
# correctness comes from draining every page.
_PAGE_SIZE = 200


def _seg(value: Any) -> str:
    """URL-encode a single path segment so browser-supplied ids can't inject
    query params or traverse the path (``/``, ``?``, ``#`` are neutralised)."""
    return quote(str(value), safe="")


def _collection(kind: str) -> str:
    """The contract's singular ``kind`` → Monad's collection path segment.
    Spelled out rather than appending "s", so the mapping is a fact."""
    return "inputs" if kind == "input" else "outputs"


class MonadClient:
    """Talks to the Monad API with the host's long-lived key."""

    def __init__(
        self,
        api_key: str,
        api_base: str,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self._base = api_base.rstrip("/")
        self._headers = {
            "Authorization": f"ApiKey {api_key}",
            "Content-Type": "application/json",
        }
        self._transport = transport
        self._poll_attempts = _POLL_ATTEMPTS
        self._poll_interval = _POLL_INTERVAL

    def _open(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=30.0, transport=self._transport)

    async def _do(
        self, c: httpx.AsyncClient, method: str, path: str, json_body: Any = None
    ) -> Any:
        resp = await c.request(method, self._base + path, headers=self._headers, json=json_body)
        if resp.status_code >= 400:
            raise MonadError(resp.status_code, f"{resp.status_code} {path}: {resp.text[:300]}")
        if not resp.content:
            return None
        return resp.json()

    async def mint_session(self, org: str) -> Session:
        async with self._open() as c:
            data = await self._do(
                c, "POST", "/v3/sessions", {"ttl_seconds": 1800, "organization_id": org}
            )
        return Session(
            sessionToken=data["session_token"],
            organizationId=org,
            expiresAt=data["expires_at"],
        )

    async def list_catalog(
        self, kind: str, allow: Optional[list[str]]
    ) -> list[CatalogType]:
        async with self._open() as c:
            data = await self._do(c, "GET", f"/v1/{_collection(kind)}")
        allow_set = set(allow) if allow else None
        out: list[CatalogType] = []
        for t in data or []:
            if allow_set is not None and t.get("type_id") not in allow_set:
                continue
            out.append(CatalogType(typeId=t["type_id"], name=t["name"]))
        return out

    async def list_connectors(self, org: str, kind: str) -> list[ConfiguredConnector]:
        """Every connector of a kind the tenant has configured.

        Monad pages this at ``limit=10`` by default with no maximum, and the
        ``/embed`` contract returns a bare array with no pagination — so
        draining the pages is the router's job. One large ``limit`` instead
        would silently truncate whichever tenant outgrows it.
        """
        key = _collection(kind)
        out: list[ConfiguredConnector] = []
        async with self._open() as c:
            offset = 0
            while True:
                page = await self._do(
                    c, "GET", f"/v1/{_seg(org)}/{key}?limit={_PAGE_SIZE}&offset={offset}"
                )
                # Monad returns the list as null (not []) for an empty page, so
                # coalesce with `or []` — a bare .get(key, []) would return null.
                rows = (page or {}).get(key) or []
                out.extend(
                    ConfiguredConnector(id=r["id"], typeId=r["type"], name=r["name"])
                    for r in rows
                )
                # A short page is the last page; `total` only lets us stop one
                # round trip earlier when the count divides evenly.
                if len(rows) < _PAGE_SIZE:
                    return out
                total = ((page or {}).get("pagination") or {}).get("total")
                if isinstance(total, int) and len(out) >= total:
                    return out
                offset += _PAGE_SIZE

    async def wire_pipeline(
        self, org: str, input_id: str, output_id: str, name: str
    ) -> BuiltPipeline:
        body = {
            "name": name,
            "description": "Created when the connector was configured via embed",
            "enabled": True,
            "nodes": [
                {"slug": "in", "component_id": input_id, "component_type": "input", "enabled": True},
                {"slug": "out", "component_id": output_id, "component_type": "output", "enabled": True},
            ],
            "edges": [
                {
                    "from_node_instance_id": "in",
                    "to_node_instance_id": "out",
                    "description": "all records",
                    "conditions": {"operator": "always"},
                }
            ],
        }
        async with self._open() as c:
            created = await self._do(c, "POST", f"/v2/{_seg(org)}/pipelines/", body)
            pid = created["id"]
            status = "Pending"
            for _ in range(self._poll_attempts):
                s = await self._do(c, "GET", f"/v2/{_seg(org)}/pipelines/{_seg(pid)}/status")
                status = (s or {}).get("status") or status
                if status in ("Running", "Erroring"):
                    break
                await asyncio.sleep(self._poll_interval)
        return BuiltPipeline(
            pipelineId=pid, outputId=output_id, status=status, active=status == "Running"
        )

    async def build_dev_null(self, org: str, input_id: str, name: str) -> BuiltPipeline:
        async with self._open() as c:
            out = await self._do(
                c,
                "POST",
                f"/v2/{_seg(org)}/outputs",
                {
                    # `type` is canonical; `output_type` is a deprecated alias.
                    "type": "dev-null",
                    "name": f"{name} → /dev/null",
                    "description": "Auto-created sink for embed pipeline",
                    "promise_id": "",
                    "config": {"settings": {}, "secrets": {}},
                },
            )
        return await self.wire_pipeline(org, input_id, out["id"], name)

    async def _pipeline_nodes(self, c: httpx.AsyncClient, org: str, pid: str) -> list[dict]:
        """A pipeline's wiring. The detail response is flat — the nodes sit at
        the top level, not under a ``config`` envelope."""
        data = await self._do(c, "GET", f"/v2/{_seg(org)}/pipelines/{_seg(pid)}")
        return (data or {}).get("nodes") or []

    async def pipeline_for(self, org: str, kind: str, connector_id: str) -> PipelineStatus:
        """The pipeline a configured connector is wired into.

        Monad answers this directly: ``GET /v1/{org}/{kind}s/{id}`` returns
        ``component_of``, the pipelines the component is a node of. Walking the
        org's pipeline list instead would be both O(n) and wrong — that list
        pages at 10, so any pipeline past the first page would read as "not
        connected".

        ``component_of`` carries no wiring (the datastore fills only a summary
        projection), so resolving the peer connector costs one further fetch.
        Raises :class:`MonadError` with status 404 when the connector is gone.
        """
        async with self._open() as c:
            connector = await self._do(
                c, "GET", f"/v1/{_seg(org)}/{_collection(kind)}/{_seg(connector_id)}"
            )
            pipelines = (connector or {}).get("component_of") or []
            if not pipelines or not pipelines[0].get("id"):
                return PipelineStatus(hasPipeline=False, enabled=False)

            pipeline = pipelines[0]
            peer_type = "output" if kind == "input" else "input"
            nodes = await self._pipeline_nodes(c, org, pipeline["id"])
            peer = next((n for n in nodes if n.get("component_type") == peer_type), None)
            peer_id = peer.get("component_id") if peer else None

        return PipelineStatus(
            hasPipeline=True,
            enabled=bool(pipeline.get("enabled")),
            pipelineId=pipeline["id"],
            outputId=peer_id if kind == "input" else None,
            inputId=peer_id if kind == "output" else None,
        )

    async def set_enabled(self, org: str, pipeline_id: str, enabled: bool) -> None:
        """Flip a pipeline's enabled flag.

        ``PATCH`` is a true partial update: omitted fields keep their stored
        value and the node/edge graph is preserved untouched. Reading the
        pipeline and sending it back would replace the graph with whatever
        subset of fields the round trip happened to reproduce — silently
        dropping node ``config_overrides`` and edge ``schema_detection_spec``.
        """
        async with self._open() as c:
            await self._do(
                c,
                "PATCH",
                f"/v2/{_seg(org)}/pipelines/{_seg(pipeline_id)}",
                {"enabled": enabled},
            )

    async def delete(self, path: str) -> None:
        async with self._open() as c:
            await self._do(c, "DELETE", path)
