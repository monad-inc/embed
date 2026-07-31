// Command conformance boots the Go /embed router for the conformance harness,
// pointed at the mock Monad API via MONAD_API_BASE and listening on PORT.
package main

import (
	"net/http"
	"os"

	embed "github.com/monad-inc/embed/routers/go"
)

func main() {
	cfg := embed.Config{
		APIKey:      "conf-key",
		APIBase:     os.Getenv("MONAD_API_BASE"),
		FrameOrigin: "https://app.monad.com/embed",
		GetCustomerOrgID: func(r *http.Request) (string, error) {
			return "org_conf", nil
		},
		GetProvisionedComponents: func(org string) embed.Provision {
			return embed.Provision{DestinationOutputID: "out_store", SourceInputID: "in_source"}
		},
		CatalogAllow: []string{"aws-cloudtrail", "okta-systemlog"},
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
