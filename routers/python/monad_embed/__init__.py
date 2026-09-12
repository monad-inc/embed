"""monad-embed — a mountable ``/embed`` backend router (FastAPI).

Implements the ``/embed`` route contract (``packages/embed/openapi/embed.openapi.yaml``)
for a Monad embed integration.

    from fastapi import FastAPI
    from monad_embed import EmbedConfig, Provision, embed_router

    app = FastAPI()
    app.include_router(
        embed_router(EmbedConfig(
            api_key=os.environ["MONAD_API_KEY"],
            api_base="https://app.monad.com/api",
            frame_origin="https://app.monad.com/embed",
            get_customer_org_id=lambda req: req.session["org_id"],   # your auth → Monad team
            get_provisioned_components=lambda org: Provision(destination_output_id=STORES[org]),
        )),
        prefix="/embed",
    )
"""

from .client import MonadClient
from .config import EmbedConfig, Provision
from .errors import EmbedError, MonadError
from .router import embed_router

__all__ = [
    "EmbedConfig",
    "Provision",
    "MonadClient",
    "EmbedError",
    "MonadError",
    "embed_router",
]
