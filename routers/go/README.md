# Monad Embed — Go router

A mountable `/embed` backend router for a Monad embed integration, on the
standard `net/http`. Implements the [`/embed` route contract](../../packages/embed/openapi/embed.openapi.yaml).

```go
import embed "github.com/monad-inc/embed/routers/go"

h := embed.Router(embed.Config{
    APIKey: os.Getenv("MONAD_API_KEY"),
    // your auth → the tenant's Monad team id
    GetCustomerOrgID: func(r *http.Request) (string, error) { return sessionOrg(r), nil },
    // server-side lookup of a tenant's pre-provisioned components (which
    // destination an input feeds, etc.)
    GetProvisionedComponents: func(org string) embed.Provision {
        return embed.Provision{DestinationOutputID: stores[org]}
    },
})

mux.Handle("/embed/", http.StripPrefix("/embed", h))
```

Mount under `/embed` (via `http.StripPrefix`) so the router sees `/session`,
`/pipelines/ingress`, etc. The browser holds only a session token; this router
holds the API key and is the seam to the Monad API.

## Mounting on common frameworks

`embed.Router(cfg)` is a standard `http.Handler` that expects root-relative
paths, so mount it under `/embed` and strip the prefix. Assume `h := embed.Router(cfg)`.

**net/http** — standard library (Go 1.22+)

```go
mux := http.NewServeMux()
mux.Handle("/embed/", http.StripPrefix("/embed", h))
```

**chi** — [go-chi/chi](https://github.com/go-chi/chi)

```go
r := chi.NewRouter()
r.Mount("/embed", http.StripPrefix("/embed", h))
```

**gorilla/mux** — [gorilla/mux](https://github.com/gorilla/mux)

```go
r := mux.NewRouter()
r.PathPrefix("/embed/").Handler(http.StripPrefix("/embed", h))
```

**Echo** — [labstack/echo](https://github.com/labstack/echo)

```go
e.Any("/embed/*", echo.WrapHandler(http.StripPrefix("/embed", h)))
```

**Gin** — [gin-gonic/gin](https://github.com/gin-gonic/gin)

```go
r.Any("/embed/*any", gin.WrapH(http.StripPrefix("/embed", h)))
```

## Config

| Field                      | Purpose                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `APIKey`                   | Long-lived Monad API key (server-side only).                                                                   |
| `APIBase`                  | Monad API base. Optional — defaults to `https://app.monad.com/api` (production).                               |
| `FrameOrigin`              | Iframe origin returned by `GET /embed/config`. Optional — defaults to production.                              |
| `GetCustomerOrgID`         | Map the authenticated request → the tenant's Monad team id. Return `("", nil)` or an error to reject (→ 401).  |
| `GetProvisionedComponents` | Per-tenant `Provision{ DestinationOutputID, SourceInputID }`. Nil → ingress uses dev/null, egress unavailable. |
| `CatalogAllow`             | Restrict the catalog to these connector type ids. Nil → all.                                                   |

Zero external dependencies. `go test ./...`, `go vet ./...`, `gofmt` clean.
