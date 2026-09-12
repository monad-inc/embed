"""Boot the Python router for conformance testing.

Default (mock) mode points at the in-memory mock via ``MONAD_API_BASE``; live
mode sets the same knobs to real Monad staging values. Every value falls back to
the mock fixture default, so nothing changes for the existing hermetic run.
"""

import os

import uvicorn
from fastapi import FastAPI

from monad_embed import EmbedConfig, Provision, embed_router

# A provisioned id may be intentionally empty (a live tenant with no store) →
# treat "" as "not provisioned" so the router falls back to a dev/null sink.
_store = os.environ.get("MONAD_STORE_ID", "out_store") or None
_source = os.environ.get("MONAD_SOURCE_ID", "in_source") or None
# Empty allow-list → expose the whole catalog (None), never the empty set.
_allow = [s.strip() for s in os.environ.get("MONAD_CATALOG_ALLOW", "aws-cloudtrail,okta-systemlog").split(",") if s.strip()] or None

app = FastAPI()
app.include_router(
    embed_router(
        EmbedConfig(
            api_key=os.environ.get("MONAD_API_KEY", "conf-key"),
            api_base=os.environ["MONAD_API_BASE"],
            frame_origin=os.environ.get("MONAD_FRAME_ORIGIN", "https://app.monad.com/embed"),
            get_customer_org_id=lambda req: os.environ.get("MONAD_ORG_ID", "org_conf"),
            get_provisioned_components=lambda org: Provision(destination_output_id=_store, source_input_id=_source),
            catalog_allow=_allow,
        )
    ),
    prefix="/embed",
)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8791")), log_level="warning")
