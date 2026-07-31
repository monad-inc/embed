// Command conformance boots the Go /embed router for the conformance harness.
//
// In the default (mock) mode the harness points it at the in-memory mock via
// MONAD_API_BASE; in live mode the same knobs are set to real Monad staging
// values. Every value falls back to the mock fixture default, so the existing
// hermetic run is unchanged.
package main

import (
	"net/http"
	"os"
	"strings"

	embed "github.com/monad-inc/embed/routers/go"
)

// envOr returns the env var value, or fallback when unset. An explicitly-empty
// value ("") is returned as-is — a live tenant may have no provisioned store.
func envOr(name, fallback string) string {
	if v, ok := os.LookupEnv(name); ok {
		return v
	}
	return fallback
}

// splitAllow parses a comma-separated allow-list; empty → nil (expose all).
func splitAllow(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func main() {
	store := envOr("MONAD_STORE_ID", "out_store")
	source := envOr("MONAD_SOURCE_ID", "in_source")

	cfg := embed.Config{
		APIKey:      envOr("MONAD_API_KEY", "conf-key"),
		APIBase:     os.Getenv("MONAD_API_BASE"),
		FrameOrigin: envOr("MONAD_FRAME_ORIGIN", "https://app.monad.com/embed"),
		GetCustomerOrgID: func(r *http.Request) (string, error) {
			return envOr("MONAD_ORG_ID", "org_conf"), nil
		},
		GetProvisionedComponents: func(org string) embed.Provision {
			return embed.Provision{DestinationOutputID: store, SourceInputID: source}
		},
		CatalogAllow: splitAllow(envOr("MONAD_CATALOG_ALLOW", "aws-cloudtrail,okta-systemlog")),
	}

	mux := http.NewServeMux()
	mux.Handle("/embed/", http.StripPrefix("/embed", embed.Router(cfg)))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8791"
	}
	if err := http.ListenAndServe("127.0.0.1:"+port, mux); err != nil {
		panic(err)
	}
}
