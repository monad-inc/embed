"""Boot the Python router for conformance testing, pointed at the mock Monad."""

import os

import uvicorn
from fastapi import FastAPI

from monad_embed import EmbedConfig, Provision, embed_router

app = FastAPI()
app.include_router(
    embed_router(
        EmbedConfig(
            api_key="conf-key",
            api_base=os.environ["MONAD_API_BASE"],
            frame_origin="https://app.monad.com/embed",
            get_customer_org_id=lambda req: "org_conf",
            get_provisioned_components=lambda org: Provision(destination_output_id="out_store", source_input_id="in_source"),
            catalog_allow=["aws-cloudtrail", "okta-systemlog"],
        )
    ),
    prefix="/embed",
)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8791")), log_level="warning")
