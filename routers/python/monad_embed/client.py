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


def _seg(value: Any) -> str:
    """URL-encode a single path segment so browser-supplied ids can't inject
    query params or traverse the path (``/``, ``?``, ``#`` are neutralised)."""
    return quote(str(value), safe="")


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
            data = await self._do(c, "GET", f"/v1/{kind}s")
        allow_set = set(allow) if allow else None
        out: list[CatalogType] = []
        for t in data or []:
            if allow_set is not None and t.get("type_id") not in allow_set:
                continue
            out.append(CatalogType(typeId=t["type_id"], name=t["name"]))
        return out

    async def list_connectors(self, org: str, kind: str) -> list[ConfiguredConnector]:
        async with self._open() as c:
            page = await self._do(c, "GET", f"/v1/{_seg(org)}/{kind}s?limit=1000&offset=0")
        # Monad returns the list as null (not []) when a tenant has none, so
        # coalesce with `or []` — a bare .get(key, []) would return that null.
        rows = (page or {}).get(f"{kind}s") or []
        return [
            ConfiguredConnector(id=r["id"], typeId=r["type"], name=r["name"]) for r in rows
        ]

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
                    "output_type": "dev-null",
                    "name": f"{name} → /dev/null",
                    "description": "Auto-created sink for embed pipeline",
                    "promise_id": "",
                    "config": {"settings": {}, "secrets": {}},
                },
            )
        return await self.wire_pipeline(org, input_id, out["id"], name)

    async def _list_pipelines(self, c: httpx.AsyncClient, org: str) -> list[dict]:
        data = await self._do(c, "GET", f"/v2/{_seg(org)}/pipelines/")
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return data.get("pipelines") or data.get("data") or []
        return []

    async def _get_pipeline(self, c: httpx.AsyncClient, org: str, pid: str) -> dict:
        data = await self._do(c, "GET", f"/v2/{_seg(org)}/pipelines/{_seg(pid)}")
        if isinstance(data, dict):
            return data.get("config") or data
        return {}

    async def status_by_input(self, org: str, input_id: str) -> PipelineStatus:
        async with self._open() as c:
            for summary in await self._list_pipelines(c, org):
                pid = summary.get("id")
                if not pid:
                    continue
                try:
                    p = await self._get_pipeline(c, org, pid)
                except MonadError:
                    continue
                nodes = p.get("nodes") or []
                in_node = next(
                    (n for n in nodes if n.get("component_type") == "input" and n.get("component_id") == input_id),
                    None,
                )
                if in_node is None:
                    continue
                out_node = next((n for n in nodes if n.get("component_type") == "output"), None)
                return PipelineStatus(
                    hasPipeline=True,
                    enabled=bool(p.get("enabled")),
                    pipelineId=pid,
                    outputId=out_node.get("component_id") if out_node else None,
                )
        return PipelineStatus(hasPipeline=False, enabled=False)

    async def find_by_output(self, org: str, output_id: str) -> PipelineStatus:
        async with self._open() as c:
            for summary in await self._list_pipelines(c, org):
                pid = summary.get("id")
                if not pid:
                    continue
                try:
                    p = await self._get_pipeline(c, org, pid)
                except MonadError:
                    continue
                nodes = p.get("nodes") or []
                out_node = next(
                    (n for n in nodes if n.get("component_type") == "output" and n.get("component_id") == output_id),
                    None,
                )
                if out_node is None:
                    continue
                in_node = next((n for n in nodes if n.get("component_type") == "input"), None)
                return PipelineStatus(
                    hasPipeline=True,
                    enabled=bool(p.get("enabled")),
                    pipelineId=pid,
                    inputId=in_node.get("component_id") if in_node else None,
                )
        return PipelineStatus(hasPipeline=False, enabled=False)

    async def set_enabled(self, org: str, pipeline_id: str, enabled: bool) -> None:
        async with self._open() as c:
            p = await self._get_pipeline(c, org, pipeline_id)
            nodes = [
                {
                    "id": n.get("id"),
                    "slug": n.get("slug"),
                    "component_id": n.get("component_id"),
                    "component_type": n.get("component_type"),
                    "enabled": n.get("enabled", True),
                }
                for n in (p.get("nodes") or [])
            ]
            edges = [
                {
                    "name": e.get("name"),
                    "description": e.get("description", ""),
                    "from_node_instance_id": e.get("from_node_instance_id"),
                    "to_node_instance_id": e.get("to_node_instance_id"),
                    "disabled": e.get("disabled", False),
                    "conditions": e.get("conditions"),
                }
                for e in (p.get("edges") or [])
            ]
            await self._do(
                c,
                "PATCH",
                f"/v2/{_seg(org)}/pipelines/{_seg(pipeline_id)}",
                {
                    "name": p.get("name"),
                    "description": p.get("description", ""),
                    "enabled": enabled,
                    "nodes": nodes,
                    "edges": edges,
                },
            )

    async def delete(self, path: str) -> None:
        async with self._open() as c:
            await self._do(c, "DELETE", path)
