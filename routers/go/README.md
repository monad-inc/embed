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
| `GetCustomerOrgID`         | **The tenant-isolation boundary** — see below. Return `("", nil)` or an error to reject (→ 401).               |
| `GetProvisionedComponents` | Per-tenant `Provision{ DestinationOutputID, SourceInputID }`. Nil → ingress uses dev/null, egress unavailable. |
| `CatalogAllow`             | Restrict the catalog to these connector type ids. Nil → all.                                                   |

### `GetCustomerOrgID` is a security boundary

This callback is the only thing standing between one of your tenants and
another's data. The router holds a Monad API key with access to every
organization your key can reach; whatever org id this returns is the org the
request then reads, writes and deletes in. Get it wrong and you serve tenant A
the pipelines of tenant B.

So derive the org **from your own authenticated session** — the thing your auth
middleware already verified:

```go
GetCustomerOrgID: func(r *http.Request) (string, error) {
    user, ok := auth.FromContext(r.Context()) // set by your auth middleware
    if !ok {
        return "", errors.New("not signed in")
    }
    return user.MonadOrgID, nil // your tenant → Monad org mapping
}
```

Never take it from anything the caller controls — a header, a query param, a
request body field, or a client-supplied JWT claim you have not verified. Those
are all attacker-chosen values, and the router will use them verbatim.

Mount the router behind your auth middleware; it performs no authentication of
its own beyond calling this hook, and treats `("", nil)` or a non-nil error as
`401`.

You own this mapping because only you can know it: Monad has no endpoint that
turns your product's bearer token into an org id. (`GET /v1/organizations` maps
a _Monad API key_ to the orgs it can reach — not your user to their tenant.)
Store the tenant → org id association when you provision the tenant.

Zero external dependencies. `go test ./...`, `go vet ./...`, `gofmt` clean.
