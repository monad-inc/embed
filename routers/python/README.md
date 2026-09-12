# Monad Embed — Python router

A mountable `/embed` backend router for a Monad embed integration, as a FastAPI
`APIRouter`. Implements the [`/embed` route contract](../../packages/embed/openapi/embed.openapi.yaml).

```python
from fastapi import FastAPI
from monad_embed import EmbedConfig, Provision, embed_router

app = FastAPI()
app.include_router(
    embed_router(EmbedConfig(
        api_key=os.environ["MONAD_API_KEY"],
        # your auth → the tenant's Monad team id (sync or async)
        get_customer_org_id=lambda req: req.session["org_id"],
        # server-side lookup of a tenant's pre-provisioned components
        get_provisioned_components=lambda org: Provision(destination_output_id=STORES[org]),
    )),
    prefix="/embed",
)
```

Mounted with `prefix="/embed"`, the router serves `/embed/session`,
`/embed/pipelines/ingress`, etc. The browser holds only a session token; this
router holds the API key and is the seam to the Monad API.

## Mounting on common frameworks

`embed_router(cfg)` is a FastAPI `APIRouter` (ASGI), so it slots into any FastAPI
or Starlette app. Assume `router = embed_router(cfg)` below.

**FastAPI** — include it in your app

```python
app.include_router(router, prefix="/embed")
```

**FastAPI** — as an isolated sub-application (its own docs, middleware, lifespan)

```python
embed_app = FastAPI()
embed_app.include_router(router)
app.mount("/embed", embed_app)
```

**Starlette** — [starlette](https://www.starlette.io)

```python
from starlette.applications import Starlette
from starlette.routing import Mount

embed_app = FastAPI()
embed_app.include_router(router)

app = Starlette(routes=[
    Mount("/embed", app=embed_app),
    # ... your other routes
])
```

Serve it with any ASGI server:

```sh
uvicorn app:app
# or: gunicorn -k uvicorn.workers.UvicornWorker app:app
# or: hypercorn app:app
```

**Flask / Django (WSGI)** — the router is ASGI, so either run it as its own
service, or host it inside your WSGI app with an ASGI bridge such as
[`a2wsgi`](https://github.com/abersheeran/a2wsgi):

```python
from a2wsgi import ASGIMiddleware
from werkzeug.middleware.dispatcher import DispatcherMiddleware

embed_app = FastAPI()
embed_app.include_router(router)

# /embed/* → the ASGI embed app; everything else → Flask
flask_app.wsgi_app = DispatcherMiddleware(
    flask_app.wsgi_app,
    {"/embed": ASGIMiddleware(embed_app)},
)
```

## Config

| Field                        | Purpose                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `api_key`                    | Long-lived Monad API key (server-side only).                                                                 |
| `api_base`                   | Monad API base. Optional — defaults to `https://app.monad.com/api` (production).                             |
| `frame_origin`               | Iframe origin returned by `GET /embed/config`. Optional — defaults to production.                            |
| `get_customer_org_id`        | `Request → org id`, sync or async. Return `""` / raise to reject (→ 401).                                    |
| `get_provisioned_components` | `org → Provision(destination_output_id, source_input_id)`. Omit → ingress uses dev/null, egress unavailable. |
| `catalog_allow`              | Restrict the catalog to these connector type ids. Omit → all.                                                |

## Develop

```sh
uv venv --python 3.10 .venv
uv pip install --python .venv/bin/python "fastapi>=0.110" "httpx>=0.27" "pytest>=8"
.venv/bin/python -m pytest -q
```
