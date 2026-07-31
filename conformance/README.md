# `/embed` conformance suite

Proves that every backend router behaves identically and matches the
[`/embed` contract](../packages/embed/openapi/embed.openapi.yaml). It is
**language-agnostic** — it boots a router under test and drives it over HTTP, so
the same suite runs against the TypeScript, Go, and Python routers (and any
future one).

## How it works

```
mock_monad.py  ── a stateful in-memory stand-in for the Monad API
      ▲
      │ MONAD_API_BASE
router under test  ── booted by conftest.py (ROUTER=python|go|ts), mounted at /embed
      ▲
      │ HTTP
tests ── test_conformance.py (Schemathesis)  +  test_scenarios.py (lifecycle)
```

- **`test_conformance.py`** — Schemathesis reads the OpenAPI spec, generates
  requests for every operation, and asserts each response matches the documented
  **status code, response schema, and content type**.
- **`test_scenarios.py`** — the stateful lifecycle Schemathesis's stateless
  fuzzing can't cover: mint → build ingress → status → disable → status →
  remove → status, plus egress.

The router is booted with a stubbed `getCustomerOrgID` (always the tenant
`org_conf`) and provisioning (`destinationOutputId=out_store`, `sourceInputId=in_source`),
pointed at the mock. Nothing touches real Monad.

## Run

```sh
# one-time: create the harness venv (installs Schemathesis + the Python router)
uv venv --python 3.10 .venv
uv pip install --python .venv/bin/python schemathesis pytest httpx fastapi uvicorn -e ../routers/python

./run.sh                 # all routers: python go ts
./run.sh python go       # a subset
ROUTER=ts .venv/bin/python -m pytest -q   # a single router directly
```

Prerequisites per router: **python** — none (uses the harness venv); **go** —
a Go toolchain (`go run ./cmd/conformance`); **ts** — the built package
(`run.sh` runs `pnpm -C packages/embed build` automatically).

## Scope note — auth and negative input

The suite runs Schemathesis's **response-conformance** checks
(`status_code_conformance`, `response_schema_conformance`,
`content_type_conformance`). It deliberately does **not** run the
`ignored_auth` or `negative_data_rejection` checks: auth is the host's
responsibility — each router mounts _behind_ the host's auth middleware and
trusts `getCustomerOrgID`, which the harness stubs — so those checks would test the
stub, not the router. A `5xx` is a documented, conformant outcome here
(`500 internal_error`, `502 upstream_error`).
