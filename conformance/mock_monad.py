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
- ``POST /v2/{org}/pipelines``       → **201** with the full pipeline object.
- ``GET  /v2/{org}/pipelines``       → ``{ "pipelines": [...], "pagination": {...} }``.
- ``GET  /v2/{org}/pipelines/{id}``  → the full pipeline object at top level
                                        (``nodes``/``edges``/``enabled`` — no ``config`` wrapper).
- ``POST /v2/{org}/outputs``         → the created output object.
- ``POST /v3/sessions``              → ``{ "session_token", "expires_at" }``.
"""

from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class _State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.pipelines: dict[str, dict] = {}
        self._counter = 0

    def new_id(self, prefix: str) -> str:
        with self.lock:
            self._counter += 1
            return f"{prefix}_{self._counter}"


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
    return {
        "id": oid,
        "name": body.get("name", ""),
        "description": body.get("description", ""),
        "type": body.get("output_type", "dev-null"),
        "organization_id": "org_conf",
        "managed_by": "",
        "config": {"settings": {}, "secrets": {}},
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }


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
            # and returned as null (not []) when the tenant has none. Exercise
            # both shapes: a populated `inputs`, an empty (null) `outputs`.
            m = re.fullmatch(r"/v1/([^/]+)/(inputs|outputs)", path)
            if method == "GET" and m:
                kind = m.group(2)
                rows = (
                    None
                    if kind == "outputs"
                    else [
                        {
                            "id": "cfg_1",
                            "type": "aws-cloudtrail",
                            "name": "Configured",
                            "organization_id": "org_conf",
                            "config": {"settings": {}, "secrets": {}},
                        }
                    ]
                )
                return self._send(
                    200,
                    {
                        kind: rows,
                        "pagination": {"limit": 1000, "offset": 0, "total": 0 if rows is None else 1},
                    },
                )

            # Create an output (e.g. the dev/null sink) — the created record.
            if method == "POST" and re.fullmatch(r"/v2/([^/]+)/outputs", path):
                return self._send(200, _output_view(state.new_id("out"), body))

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
                    with state.lock:
                        items = [_pipeline_summary(p) for p in state.pipelines.values()]
                    return self._send(
                        200,
                        {
                            "pipelines": items,
                            "pagination": {"limit": 1000, "offset": 0, "total": len(items)},
                        },
                    )

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

            if method == "DELETE" and re.fullmatch(r"/v1/([^/]+)/(inputs|outputs)/([^/]+)", path):
                return self._send(204)

            return self._send(404, {"error": f"mock unhandled {method} {path}"})

    return Handler


def start(port: int):
    """Start the mock on 127.0.0.1:port in a background thread. Returns (server, state)."""
    state = _State()
    server = ThreadingHTTPServer(("127.0.0.1", port), _make_handler(state))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, state
