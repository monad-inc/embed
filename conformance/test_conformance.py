"""Schemathesis property-based conformance: does every response match the spec?

Schemathesis reads the OpenAPI contract, generates requests for every operation,
and asserts each response conforms — documented status code, response schema,
and content type. This is language-agnostic: it drives whichever router the
``servers`` fixture booted.
"""

import os

import pytest
import schemathesis
from schemathesis.specs.openapi.checks import (
    content_type_conformance,
    response_schema_conformance,
    status_code_conformance,
)

_SPEC = os.path.join(
    os.path.dirname(__file__), "..", "packages", "embed", "openapi", "embed.openapi.yaml"
)
_BASE_URL = os.environ.get("ROUTER_BASE_URL", "http://127.0.0.1:8791")

# Against real Monad (live mode) the fuzzer must not create resources with
# generated payloads — restrict it to read-only GET operations, which are also
# exactly the response-shape surface that has bitten us (catalog/connectors).
LIVE = os.environ.get("MONAD_LIVE") == "1"

schema = schemathesis.openapi.from_path(_SPEC)

# We validate RESPONSE conformance: every response the router returns for every
# operation must match the spec's documented status code, response schema, and
# content type. We deliberately do NOT run Schemathesis's security/negative
# checks (`ignored_auth`, `negative_data_rejection`): auth is the host's job —
# the router mounts *behind* the host's auth middleware, and the conformance
# harness stubs `getCustomerOrgID` to always succeed — so those checks would test
# the harness stub, not the router's contract behavior. A 5xx is also a
# documented, conformant outcome here (500/502), so `not_a_server_error` is out.
_CONFORMANCE_CHECKS = [
    status_code_conformance,
    response_schema_conformance,
    content_type_conformance,
]


@schema.parametrize()
def test_response_conforms_to_spec(case):
    if LIVE and case.method.upper() != "GET":
        pytest.skip("live mode fuzzes read-only GET operations only (no real mutations)")
    case.call_and_validate(base_url=_BASE_URL, checks=_CONFORMANCE_CHECKS)
