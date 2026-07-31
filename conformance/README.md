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
                +  test_mock_fidelity.py (mock ⟷ Monad shapes)
```

- **`test_conformance.py`** — Schemathesis reads the `/embed` OpenAPI spec,
  generates requests for every operation, and asserts each response matches the
  documented **status code, response schema, and content type**.
- **`test_scenarios.py`** — the stateful lifecycle Schemathesis's stateless
  fuzzing can't cover: mint → build ingress → status → disable → status →
  remove → status, plus egress.
- **`test_mock_fidelity.py`** — pins the mock to the **Monad** response shapes
  the routers consume (`monad_schemas.py`, vendored from Monad's OpenAPI), so the
  mock can't drift from the documented upstream contract on a field a router
  parses. This is the check that would have caught a missing `pagination`
  sibling for free. (Needs `jsonschema`.)

The router is booted with a stubbed `getCustomerOrgID` (always the tenant
`org_conf`) and provisioning (`destinationOutputId=out_store`, `sourceInputId=in_source`),
pointed at the mock. Nothing touches real Monad.

## Two contracts, two directions

The suite guards both contracts the router sits between:

- **downstream** — `test_conformance.py` proves the router's `/embed` responses
  match _our_ published contract (`packages/embed/openapi/embed.openapi.yaml`).
- **upstream** — `test_mock_fidelity.py` proves the _mock_ matches _Monad's_
  documented shapes. But a spec is only as good as its accuracy: Monad's spec
  types the connectors list as `array` yet real Monad returns `null` when empty
  (the bug that hit the Python router). So spec-fidelity alone is not enough —
  **live mode** (below) closes the gap by running the routers against real Monad.

## Live mode — run the routers against real Monad

The default run is hermetic (mock). Set `MONAD_LIVE=1` and point the same env at
real Monad staging to run the **identical** read-path scenarios against the real
API — the only thing that catches where reality diverges from the spec:

```sh
MONAD_LIVE=1 \
MONAD_API_BASE=https://app.monad.security/api \
MONAD_API_KEY=<staging key> \
MONAD_ORG_ID=<tenant org> \
MONAD_SOURCE_ID=<provisioned input id> \
MONAD_FRAME_ORIGIN=https://app.monad.security/embed \
ROUTER=python .venv/bin/python -m pytest -q
```

In live mode the mock is not booted; Schemathesis is restricted to **read-only
GET** operations (no fuzzed mutations against real Monad); and the mutating
lifecycle scenarios are skipped unless you opt in with `MONAD_LIVE_MUTATE=1`
plus throwaway `CONF_INPUT_ID` / `CONF_OUTPUT_ID` components (they create and
then delete real pipelines, keeping the shared source). Every knob defaults to
the mock fixture value, so an unset env is exactly the hermetic run.

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
