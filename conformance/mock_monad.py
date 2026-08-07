"""A stateful in-memory stand-in for the Monad API.

The conformance harness boots a router under test pointed at this mock (via
``MONAD_API_BASE``) so the routers run their real logic without touching real
Monad. It is stateful enough for the lifecycle scenario: creating a pipeline
stores it, listing/detail return it, PATCH updates it, DELETE removes it.

Response shapes here mirror the **real Monad API** (from its OpenAPI /
``pkg/routes``) so a router that mis-parses a real response is caught:

- ``GET /v1/{kind}s`` (catalog)      → a bare array of connector types.
- ``GET /v1/{org}/{kind}s``          → ``{ "<kind>s": [...] | null, "pagination": {...} }``
                                        (the list is **null**, not ``[]``, when empty).
- ``GET /v1/{org}/{kind}s/{id}``     → the connector record + ``component_of``,
                                        the pipelines it is a node of.
- ``POST /v2/{org}/pipelines``       → **201** with the full pipeline object.
- ``GET  /v2/{org}/pipelines``       → ``{ "pipelines": [...], "pagination": {...} }``.
- ``GET  /v2/{org}/pipelines/{id}``  → the full pipeline object at top level
                                        (``nodes``/``edges``/``enabled`` — no ``config`` wrapper).
- ``POST /v2/{org}/outputs``         → the created output object.
- ``POST /v3/sessions``              → ``{ "session_token", "expires_at" }``.

**Pagination is enforced, and the default limit is 10** — matching every list
handler in Monad (``api/pkg/routes/v2/routes/pipelines.go:727`` and friends).
A router that omits ``limit`` gets 10 rows here exactly as it would in
production, which is what turns the "only ever sees 10" class of bug into a
test failure instead of a live incident.
"""

from __future__ import annotations

import json
import re
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Monad's list handlers all default to 10 and enforce no maximum.
DEFAULT_LIMIT = 10

# Enough configured inputs that a router which does not page sees a truncated
# list. `test_connectors_pagination_is_exhaustive` pins the full count.
_SEEDED_INPUTS = 12

# Inputs the bulk-pipeline scenario wires, one pipeline each, to push the
# pipeline list past its first page.
_BULK_INPUTS = 12


def _seed_connectors() -> dict[str, dict[str, dict]]:
    """The tenant's configured connectors, keyed by id.

    `outputs` is deliberately empty so `GET /v1/{org}/outputs` returns **null**
    — the real-Monad behavior its own spec gets wrong, and the reason live mode
    exists. `out_store`/`out_conf` are the host's pre-provisioned components:
    resolvable by id, but not part of the tenant's own list.
    """
    inputs = {
        f"cfg_{i}": {
            "id": f"cfg_{i}",
            "type": "aws-cloudtrail" if i % 2 else "okta-systemlog",
            "name": f"Configured {i}",
            "organization_id": "org_conf",
            "config": {"settings": {}, "secrets": {}},
        }
        for i in range(1, _SEEDED_INPUTS + 1)
    }
    # Ids the lifecycle scenarios wire, resolvable but outside the listed page
    # so they cannot perturb the pagination counts. `bulk_*` exists to push the
    # pipeline list past its first page.
    extras = ["in_conf", "in_dup_conflict"] + [f"bulk_{i}" for i in range(1, _BULK_INPUTS + 1)]
    for extra in extras:
        inputs[extra] = {
            "id": extra,
            "type": "aws-cloudtrail",
            "name": extra,
            "organization_id": "org_conf",
            "config": {"settings": {}, "secrets": {}},
            "listed": False,
        }
    outputs = {
        oid: {
            "id": oid,
            "type": "dev-null",
            "name": oid,
            "organization_id": "org_conf",
            "config": {"settings": {}, "secrets": {}},
            "listed": False,
        }
        for oid in ("out_store", "out_conf")
    }
    return {"input": inputs, "output": outputs}


class _State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.pipelines: dict[str, dict] = {}
        self.connectors = _seed_connectors()
        self._counter = 0

    def new_id(self, prefix: str) -> str:
        with self.lock:
            self._counter += 1
            return f"{prefix}_{self._counter}"


def _paginate(rows: list, limit: int, offset: int) -> tuple[list | None, dict]:
    """Slice `rows` the way Monad does, and build the `pagination` sibling.

    An empty page comes back as ``None``, not ``[]`` — see the module note.
    `total` is the full count, not the page length.
    """
    page = rows[offset : offset + limit]
    return (page or None), {"limit": limit, "offset": offset, "total": len(rows)}


def _component_ids(pipeline: dict) -> frozenset:
    """The set of component ids a pipeline wires — used to detect a duplicate
    connection (Monad rejects connecting the same components twice → 409)."""
    return frozenset(
        n.get("component_id") for n in pipeline.get("nodes", []) if n.get("component_id")
    )


def _input_id(pipeline: dict):
    return next(
        (n.get("component_id") for n in pipeline.get("nodes", []) if n.get("component_type") == "input"),
        None,
    )


def _pipeline_view(p: dict) -> dict:
    """A pipeline shaped like real Monad's create / detail / patch response:
    the record at top level, with `nodes`/`edges`/`enabled` (no `config` wrapper)."""
    return {
        "id": p.get("id"),
        "name": p.get("name", ""),
        "description": p.get("description", ""),
        "enabled": bool(p.get("enabled")),
        "organization_id": "org_conf",
        "managed_by": "",
        "nodes": p.get("nodes", []),
        "edges": p.get("edges", []),
        "status": {"pipeline_id": p.get("id"), "status": "Running"},
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
    }


def _pipeline_summary(p: dict) -> dict:
    """A pipeline as it appears in the list endpoint (a lighter projection)."""
    return {
        "id": p.get("id"),
        "name": p.get("name", ""),
        "enabled": bool(p.get("enabled")),
        "input_id": _input_id(p),
        "organization_id": "org_conf",
    }


def _output_view(oid: str, body: dict) -> dict:
    # `type` is the canonical field; `output_type` is the deprecated alias the
    # API still accepts, with `type` winning when both are sent
    # (api/pkg/routes/v2/routes/organization_outputs.go:188).
    return {
        "id": oid,
        "name": body.get("name", ""),
        "description": body.get("description", ""),
        "type": body.get("type") or body.get("output_type") or "dev-null",
        "organization_id": "org_conf",
        "managed_by": "",
        "config": {"settings": {}, "secrets": {}},
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }


def _connector_view(record: dict) -> dict:
    """A configured connector as the list/detail endpoints return it."""
    return {k: v for k, v in record.items() if k != "listed"}


def _component_of(pipelines: dict[str, dict], component_id: str) -> list[dict]:
    """The pipelines a component is a node of — Monad's `component_of`.

    Deliberately the same narrow projection the datastore emits
    (core/pkg/datastore/postgres/pipelines.go:292): **no `status`, no `nodes`**.
    A router that needs the peer component has to fetch the pipeline detail.
    """
    return [
        {
            "id": p.get("id"),
            "organization_id": "org_conf",
            "name": p.get("name", ""),
            "description": p.get("description", ""),
            "enabled": bool(p.get("enabled")),
            "component_tier": 0,
            "input_id": "",
            "managed_by": "",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        }
        for p in pipelines.values()
        if component_id in _component_ids(p)
    ]


def _make_handler(state: _State):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:  # silence per-request logging
            pass

        def _send(self, code: int, obj=None) -> None:
            body = b"" if obj is None else json.dumps(obj).encode()
            self.send_response(code)
            if obj is not None:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _read(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n == 0:
                return {}
            try:
                return json.loads(self.rfile.read(n) or b"{}")
            except (ValueError, TypeError):
                return {}

        def do_GET(self):  # noqa: N802
            self._route("GET")

        def do_POST(self):  # noqa: N802
            self._route("POST")

        def do_PATCH(self):  # noqa: N802
            self._route("PATCH")

        def do_DELETE(self):  # noqa: N802
            self._route("DELETE")

        def _limit_offset(self) -> tuple[int, int]:
            """Parse `limit`/`offset` exactly as Monad's handlers do: anything
            unparseable or out of range falls back to the default."""
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

            def _int(name: str, default: int, floor: int) -> int:
                try:
                    value = int(query.get(name, [""])[0])
                except (TypeError, ValueError):
                    return default
                return value if value >= floor else default

            return _int("limit", DEFAULT_LIMIT, 1), _int("offset", 0, 0)

        def _route(self, method: str) -> None:
            path = self.path.split("?", 1)[0]
            body = self._read() if method in ("POST", "PATCH") else {}

            # Embed session mint: { session_token, expires_at }.
            if method == "POST" and path == "/v3/sessions":
                return self._send(
                    200, {"session_token": "tok_conf", "expires_at": "2026-12-31T00:00:00Z"}
                )

            # Catalog of connector types — a bare array (no wrapper).
            if method == "GET" and re.fullmatch(r"/v1/(inputs|outputs)", path):
                return self._send(
                    200,
                    [
                        {
                            "type_id": "aws-cloudtrail",
                            "name": "AWS CloudTrail",
                            "description": "AWS CloudTrail logs",
                            "category": "cloud",
                            "in_beta": False,
                        },
                        {
                            "type_id": "okta-systemlog",
                            "name": "Okta System Log",
                            "description": "Okta system log",
                            "category": "identity",
                            "in_beta": False,
                        },
                    ],
                )

            # A tenant's configured connectors — wrapped alongside `pagination`,
            # paged with Monad's default limit of 10, and returned as null (not
            # []) when the page is empty. Exercise both shapes: a populated
            # `inputs` that spans two pages, an empty (null) `outputs`.
            m = re.fullmatch(r"/v1/([^/]+)/(inputs|outputs)", path)
            if method == "GET" and m:
                kind = m.group(2)
                limit, offset = self._limit_offset()
                with state.lock:
                    all_rows = [
                        _connector_view(c)
                        for c in state.connectors[kind[:-1]].values()
                        if c.get("listed", True)
                    ]
                rows, pagination = _paginate(all_rows, limit, offset)
                return self._send(200, {kind: rows, "pagination": pagination})

            # A single configured connector + `component_of`: the pipelines it is
            # a node of. This is what lets a router resolve a connector's
            # pipeline in one call instead of walking every pipeline in the org.
            m = re.fullmatch(r"/v1/([^/]+)/(inputs|outputs)/([^/]+)", path)
            if m and method in ("GET", "DELETE"):
                kind, cid = m.group(2)[:-1], m.group(3)
                with state.lock:
                    record = state.connectors[kind].get(cid)
                    if record is None:
                        return self._send(404, {"error": f"{kind} not found"})
                    if method == "DELETE":
                        del state.connectors[kind][cid]
                        return self._send(204)
                    view = {
                        **_connector_view(record),
                        "component_of": _component_of(state.pipelines, cid),
                    }
                return self._send(200, view)

            # Create an output (e.g. the dev/null sink) — the created record.
            # It joins the tenant's connectors so it is resolvable by id and
            # deletable, like any other output.
            if method == "POST" and re.fullmatch(r"/v2/([^/]+)/outputs", path):
                view = _output_view(state.new_id("out"), body)
                with state.lock:
                    state.connectors["output"][view["id"]] = {**view, "listed": False}
                return self._send(200, view)

            # pipelines collection (create / list) — check before status/detail
            if re.fullmatch(r"/v2/([^/]+)/pipelines/?", path):
                if method == "POST":
                    pid = state.new_id("pipe")
                    with state.lock:
                        new_ids = _component_ids(body)
                        if new_ids and any(
                            _component_ids(p) == new_ids for p in state.pipelines.values()
                        ):
                            return self._send(
                                409,
                                {"error": "conflict", "message": "connector already connected"},
                            )
                        state.pipelines[pid] = {**body, "id": pid}
                        view = _pipeline_view(state.pipelines[pid])
                    # Real Monad returns 201 with the full pipeline record.
                    return self._send(201, view)
                if method == "GET":
                    limit, offset = self._limit_offset()
                    with state.lock:
                        items = [_pipeline_summary(p) for p in state.pipelines.values()]
                    page, pagination = _paginate(items, limit, offset)
                    return self._send(200, {"pipelines": page or [], "pagination": pagination})

            if method == "GET" and re.fullmatch(r"/v2/([^/]+)/pipelines/([^/]+)/status", path):
                pid = path.rsplit("/", 2)[-2]
                return self._send(
                    200,
                    {
                        "pipeline_id": pid,
                        "status": "Running",
                        "ingress": {"bytes": 0, "records": 0},
                        "egress": {"bytes": 0, "records": 0},
                        "nodes": [],
                    },
                )

            m = re.fullmatch(r"/v2/([^/]+)/pipelines/([^/]+)", path)
            if m:
                pid = m.group(2)
                if method == "GET":
                    with state.lock:
                        p = state.pipelines.get(pid)
                    if p is None:
                        return self._send(404, {"error": "pipeline not found"})
                    # The full pipeline record at top level (no `config` wrapper).
                    return self._send(200, _pipeline_view(p))
                if method == "PATCH":
                    with state.lock:
                        if pid not in state.pipelines:
                            return self._send(404, {"error": "pipeline not found"})
                        state.pipelines[pid] = {**state.pipelines[pid], **body, "id": pid}
                        view = _pipeline_view(state.pipelines[pid])
                    return self._send(200, view)
                if method == "DELETE":
                    with state.lock:
                        state.pipelines.pop(pid, None)
                    return self._send(204)

            return self._send(404, {"error": f"mock unhandled {method} {path}"})

    return Handler


def start(port: int):
    """Start the mock on 127.0.0.1:port in a background thread. Returns (server, state)."""
    state = _State()
    server = ThreadingHTTPServer(("127.0.0.1", port), _make_handler(state))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, state
