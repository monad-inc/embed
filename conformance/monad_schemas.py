"""JSON Schemas for the **Monad API** responses the routers consume.

These are the *upstream* contract the routers depend on — distinct from our own
``/embed`` contract (``packages/embed/openapi/embed.openapi.yaml``, which
Schemathesis checks). They are hand-authored from Monad's OpenAPI
(``docs/swagger.json``) + ``pkg/routes/embed`` — deliberately vendored rather
than importing Monad's internal spec into this public repo, and pared to the
fields the routers actually read.

``test_mock_fidelity.py`` validates every response the stateful mock emits
against these, so the mock can never drift from the documented Monad shapes on a
field a router parses. This is the check that would have caught the missing
``pagination`` sibling for free. Each schema allows extra properties — real
Monad returns many more fields than the routers touch.

Notes where the mock encodes reality *beyond* the spec:
- the connectors list field is ``["array", "null"]``: real Monad returns
  ``null`` (not ``[]``) for a tenant with none, though its spec types it
  ``array``. Live conformance is what proves this, but pinning it here stops the
  mock from regressing to a non-null-emitting shape.
- ``component_of`` entries are pinned *without* ``status`` or ``nodes``: the
  datastore projection behind them fills only a subset of ``models.Pipeline``
  (core/pkg/datastore/postgres/pipelines.go:292), so a router that tried to read
  a pipeline's wiring straight off ``component_of`` would work against a
  too-generous mock and fail live.
"""

# POST /v3/sessions — the embed session mint (swagger leaves the body untyped;
# shape is from pkg/routes/embed/sessions.go).
SESSION = {
    "type": "object",
    "required": ["session_token", "expires_at"],
    "properties": {
        "session_token": {"type": "string"},
        "expires_at": {"type": "string"},
    },
}

# GET /v1/{kind}s — the connector-type catalog: a bare array.
CATALOG = {
    "type": "array",
    "items": {
        "type": "object",
        "required": ["type_id", "name"],
        "properties": {
            "type_id": {"type": "string"},
            "name": {"type": "string"},
        },
    },
}


def connectors_list(kind: str) -> dict:
    """GET /v1/{org}/{kind}s — the tenant's configured connectors, wrapped
    alongside ``pagination``. The list is nullable (see module note)."""
    return {
        "type": "object",
        "required": [f"{kind}s", "pagination"],
        "properties": {
            f"{kind}s": {
                "type": ["array", "null"],
                "items": {
                    "type": "object",
                    "required": ["id", "type", "name"],
                    "properties": {
                        "id": {"type": "string"},
                        "type": {"type": "string"},
                        "name": {"type": "string"},
                    },
                },
            },
            "pagination": {"type": "object"},
        },
    }


def connector_detail(kind: str) -> dict:
    """GET /v1/{org}/{kind}s/{id} — the connector record plus ``component_of``,
    the pipelines it is a node of. This is the one call that answers "which
    pipeline is this connector wired into", so ``component_of`` is required
    even when empty."""
    return {
        "type": "object",
        "required": ["id", "type", "name", "component_of"],
        "properties": {
            "id": {"type": "string"},
            "type": {"type": "string"},
            "name": {"type": "string"},
            "component_of": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["id", "enabled"],
                    "properties": {
                        "id": {"type": "string"},
                        "name": {"type": "string"},
                        "enabled": {"type": "boolean"},
                        # Pinned absent — see the module note.
                        "status": False,
                        "nodes": False,
                    },
                },
            },
        },
    }


# A pipeline node as the routers read it (match on component_type/component_id).
_NODE = {
    "type": "object",
    "required": ["component_type", "component_id"],
    "properties": {
        "component_type": {"type": "string"},
        "component_id": {"type": "string"},
        "slug": {"type": "string"},
        "enabled": {"type": "boolean"},
    },
}

# GET/POST/PATCH /v2/{org}/pipelines/{id} — the full pipeline record. The routers
# read id/name/enabled + the nodes to resolve input/output wiring.
PIPELINE = {
    "type": "object",
    "required": ["id", "enabled", "nodes"],
    "properties": {
        "id": {"type": "string"},
        "name": {"type": "string"},
        "description": {"type": "string"},
        "enabled": {"type": "boolean"},
        "nodes": {"type": "array", "items": _NODE},
        "edges": {"type": "array"},
    },
}

# GET /v2/{org}/pipelines/ — the list. Router accepts a bare array or a wrapper.
PIPELINE_LIST = {
    "type": "object",
    "required": ["pipelines", "pagination"],
    "properties": {
        "pipelines": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id"],
                "properties": {"id": {"type": "string"}},
            },
        },
        "pagination": {"type": "object"},
    },
}

# GET /v2/{org}/pipelines/{id}/status — the router reads `status`.
PIPELINE_STATUS = {
    "type": "object",
    "required": ["status"],
    "properties": {"status": {"type": "string"}},
}

# POST /v2/{org}/outputs — the created output; the router reads `id`.
OUTPUT = {
    "type": "object",
    "required": ["id"],
    "properties": {"id": {"type": "string"}},
}
