// Package embed is a mountable /embed backend router for a Monad embed
// integration. It implements the /embed route contract
// (packages/embed/openapi/embed.openapi.yaml) on the standard net/http, so it
// mounts under any router:
//
//	h := embed.Router(embed.Config{
//		APIKey:      os.Getenv("MONAD_API_KEY"),
//		APIBase:     "https://app.monad.com/api",
//		FrameOrigin: "https://app.monad.com/embed",
//		GetCustomerOrgID: func(r *http.Request) (string, error) { return sessionOrg(r), nil },
//	})
//	mux.Handle("/embed/", http.StripPrefix("/embed", h))
//
// The browser holds only a session token; this router (holding the API key) is
// the seam to the Monad API.
package embed

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
)

// Provision is what the host pre-provisions per tenant, resolved server-side —
// never sent by the browser.
type Provision struct {
	// DestinationOutputID is the ingress target. Empty → ingress goes to a dev/null sink.
	DestinationOutputID string
	// SourceInputID is the egress source. Empty → egress is unavailable.
	SourceInputID string
}

// Config is the uniform router configuration shared across every language.
type Config struct {
	// APIKey is the long-lived Monad API key. Server-side only.
	APIKey string
	// APIBase is the Monad API base. Defaults to "https://app.monad.com/api"
	// (production); set only for non-prod.
	APIBase string
	// FrameOrigin is returned by GET /embed/config. Defaults to
	// "https://app.monad.com/embed" (production); set only for non-prod.
	FrameOrigin string
	// GetCustomerOrgID maps the authenticated request to the caller's Monad team id.
	// The one seam only the host can fill. Return a non-nil error (or "") to
	// reject an unauthenticated caller — the router responds 401.
	GetCustomerOrgID func(r *http.Request) (string, error)
	// GetProvisionedComponents returns a tenant's pre-provisioned resources. Nil →
	// ingress uses dev/null and egress is unavailable.
	GetProvisionedComponents func(org string) Provision
	// CatalogAllow restricts the catalog to these connector type ids. Nil → all.
	CatalogAllow []string
}

// ---- response shapes (camelCase per the /embed contract) ----

type configResponse struct {
	FrameOrigin string `json:"frameOrigin"`
	APIBase     string `json:"apiBase"`
}

// Session is a minted embed session, shaped to drop straight into the iframe mount.
type Session struct {
	SessionToken   string `json:"sessionToken"`
	OrganizationID string `json:"organizationId"`
	ExpiresAt      string `json:"expiresAt"`
}

// CatalogType is a connector type available to embed.
type CatalogType struct {
	TypeID string `json:"typeId"`
	Name   string `json:"name"`
}

// ConfiguredConnector is a connector a tenant has already configured.
type ConfiguredConnector struct {
	ID     string `json:"id"`
	TypeID string `json:"typeId"`
	Name   string `json:"name"`
}

// BuiltPipeline is the result of standing up a pipeline.
type BuiltPipeline struct {
	PipelineID string `json:"pipelineId"`
	OutputID   string `json:"outputId"`
	Status     string `json:"status"`
	Active     bool   `json:"active"`
}

// PipelineStatus is a configured connector's resolved pipeline state.
type PipelineStatus struct {
	HasPipeline bool   `json:"hasPipeline"`
	Enabled     bool   `json:"enabled"`
	PipelineID  string `json:"pipelineId,omitempty"`
	InputID     string `json:"inputId,omitempty"`
	OutputID    string `json:"outputId,omitempty"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ---- router ----

type handler struct {
	cfg Config
	c   *client
}

// Router builds the /embed router. Mount it under "/embed" (e.g. via
// http.StripPrefix) so it sees paths like "/session" and "/pipelines/ingress".
func Router(cfg Config) http.Handler {
	if cfg.GetCustomerOrgID == nil {
		panic("embed: Config.GetCustomerOrgID is required")
	}
	// Production defaults — set APIBase/FrameOrigin only for non-prod.
	if cfg.APIBase == "" {
		cfg.APIBase = "https://app.monad.com/api"
	}
	if cfg.FrameOrigin == "" {
		cfg.FrameOrigin = "https://app.monad.com/embed"
	}
	h := &handler{cfg: cfg, c: newClient(cfg)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /config", h.getConfig)
	mux.HandleFunc("POST /session", h.session)
	mux.HandleFunc("GET /catalog", h.catalog)
	mux.HandleFunc("GET /connectors", h.connectors)
	mux.HandleFunc("POST /pipelines/ingress", h.ingress)
	mux.HandleFunc("POST /pipelines/egress", h.egress)
	mux.HandleFunc("GET /pipelines", h.status)
	mux.HandleFunc("POST /pipelines/state", h.state)
	mux.HandleFunc("POST /pipelines/remove", h.remove)
	mux.HandleFunc("/", h.notFound)
	return mux
}

// ---- handlers ----

func (h *handler) getConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, configResponse{FrameOrigin: h.cfg.FrameOrigin, APIBase: h.cfg.APIBase})
}

func (h *handler) session(w http.ResponseWriter, r *http.Request) {
	org, ok := h.tenant(w, r)
	if !ok {
		return
	}
	s, err := h.c.mintSession(r.Context(), org)
	if err != nil {
		upstream(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func (h *handler) catalog(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.tenant(w, r); !ok {
		return
	}
	kind, ok := kindQuery(w, r.URL.Query().Get("kind"))
	if !ok {
		return
	}
	types, err := h.c.listCatalog(r.Context(), kind, h.cfg.CatalogAllow)
	if err != nil {
		upstream(w, err)
		return
	}
	writeJSON(w, http.StatusOK, types)
}

func (h *handler) connectors(w http.ResponseWriter, r *http.Request) {
	org, ok := h.tenant(w, r)
	if !ok {
		return
	}
	kind, ok := kindQuery(w, r.URL.Query().Get("kind"))
	if !ok {
		return
	}
	rows, err := h.c.listConnectors(r.Context(), org, kind)
	if err != nil {
		upstream(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (h *handler) ingress(w http.ResponseWriter, r *http.Request) {
	org, ok := h.tenant(w, r)
	if !ok {
		return
	}
	var body struct {
		InputID string `json:"inputId"`
		Name    string `json:"name"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !requireStr(w, body.InputID, "inputId") || !requireStr(w, body.Name, "name") {
		return
	}
	prov := h.prov(org)
	var built BuiltPipeline
	var err error
	if prov.DestinationOutputID != "" {
		built, err = h.c.wirePipeline(r.Context(), org, body.InputID, prov.DestinationOutputID, body.Name)
	} else {
		built, err = h.c.buildDevNull(r.Context(), org, body.InputID, body.Name)
	}
	if err != nil {
		upstream(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, built)
}

func (h *handler) egress(w http.ResponseWriter, r *http.Request) {
	org, ok := h.tenant(w, r)
	if !ok {
		return
	}
	var body struct {
		OutputID string `json:"outputId"`
		Name     string `json:"name"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !requireStr(w, body.OutputID, "outputId") || !requireStr(w, body.Name, "name") {
		return
	}
	prov := h.prov(org)
	if prov.SourceInputID == "" {
		writeErr(w, http.StatusInternalServerError, "internal_error",
			"No source input is provisioned for this tenant; egress cannot be built.")
		return
	}
	built, err := h.c.wirePipeline(r.Context(), org, prov.SourceInputID, body.OutputID, body.Name)
	if err != nil {
		upstream(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, built)
}

func (h *handler) status(w http.ResponseWriter, r *http.Request) {
	org, ok := h.tenant(w, r)
	if !ok {
		return
	}
	connectorID := r.URL.Query().Get("connectorId")
	if !requireStr(w, connectorID, "connectorId") {
		return
	}
	kind, ok := kindQuery(w, r.URL.Query().Get("kind"))
	if !ok {
		return
	}
	ps, err := h.c.pipelineFor(r.Context(), org, kind, connectorID)
	if err != nil {
		upstream(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ps)
}

func (h *handler) state(w http.ResponseWriter, r *http.Request) {
	org, ok := h.tenant(w, r)
	if !ok {
		return
	}
	var body struct {
		PipelineID string `json:"pipelineId"`
		Enabled    *bool  `json:"enabled"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !requireStr(w, body.PipelineID, "pipelineId") {
		return
	}
	if body.Enabled == nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", "Field 'enabled' must be a boolean.")
		return
	}
	if err := h.c.setEnabled(r.Context(), org, body.PipelineID, *body.Enabled); err != nil {
		upstream(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handler) remove(w http.ResponseWriter, r *http.Request) {
	org, ok := h.tenant(w, r)
	if !ok {
		return
	}
	var body struct {
		ConnectorID string `json:"connectorId"`
		Kind        string `json:"kind"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !requireStr(w, body.ConnectorID, "connectorId") {
		return
	}
	kind, ok := kindQuery(w, body.Kind)
	if !ok {
		return
	}
	ctx := r.Context()

	ps, err := h.c.pipelineFor(ctx, org, kind, body.ConnectorID)
	if err != nil {
		upstream(w, err)
		return
	}
	if ps.PipelineID != "" {
		if err := h.c.del(ctx, "/v2/"+url.PathEscape(org)+"/pipelines/"+url.PathEscape(ps.PipelineID)); err != nil {
			upstream(w, err)
			return
		}
	}

	if kind == kindInput {
		if err := h.c.del(ctx, "/v1/"+url.PathEscape(org)+"/inputs/"+url.PathEscape(body.ConnectorID)); err != nil {
			upstream(w, err)
			return
		}
		// The tenant's provisioned store is shared; only a sink this pipeline
		// created on the fly gets torn down with it.
		prov := h.prov(org)
		keepStore := prov.DestinationOutputID != "" && prov.DestinationOutputID == ps.OutputID
		if ps.OutputID != "" && !keepStore {
			if err := h.c.del(ctx, "/v1/"+url.PathEscape(org)+"/outputs/"+url.PathEscape(ps.OutputID)); err != nil {
				upstream(w, err)
				return
			}
		}
	} else {
		// Keep the shared source input; remove only the user's output.
		if err := h.c.del(ctx, "/v1/"+url.PathEscape(org)+"/outputs/"+url.PathEscape(body.ConnectorID)); err != nil {
			upstream(w, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handler) notFound(w http.ResponseWriter, r *http.Request) {
	writeErr(w, http.StatusNotFound, "not_found", "No route for "+r.Method+" "+r.URL.Path+".")
}

// ---- helpers ----

func (h *handler) tenant(w http.ResponseWriter, r *http.Request) (string, bool) {
	org, err := h.cfg.GetCustomerOrgID(r)
	if err != nil || org == "" {
		msg := "Could not resolve a tenant for the request."
		if err != nil {
			msg = err.Error()
		}
		writeErr(w, http.StatusUnauthorized, "unauthenticated", msg)
		return "", false
	}
	return org, true
}

func (h *handler) prov(org string) Provision {
	if h.cfg.GetProvisionedComponents != nil {
		return h.cfg.GetProvisionedComponents(org)
	}
	return Provision{}
}

// kindQuery is the single place a request's `kind` becomes a componentKind —
// anything else is rejected before it can reach a Monad path.
func kindQuery(w http.ResponseWriter, value string) (componentKind, bool) {
	switch componentKind(value) {
	case kindInput, kindOutput:
		return componentKind(value), true
	}
	writeErr(w, http.StatusBadRequest, "invalid_request", "'kind' must be 'input' or 'output'.")
	return "", false
}

func requireStr(w http.ResponseWriter, value, field string) bool {
	if value == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "Field '"+field+"' is required.")
		return false
	}
	return true
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", "Request body must be valid JSON.")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Code: code, Message: message})
}

// upstream maps a failed Monad call to the contract's 502 upstream_error.
func upstream(w http.ResponseWriter, err error) {
	// Translate Monad's own status codes into the contract's error model.
	var ue *upstreamError
	if errors.As(err, &ue) {
		switch ue.status {
		case http.StatusNotFound:
			writeErr(w, http.StatusNotFound, "not_found",
				"The referenced connector or pipeline does not exist.")
			return
		case http.StatusConflict:
			writeErr(w, http.StatusConflict, "conflict",
				"The request conflicts with existing state.")
			return
		}
	}
	// Anything else: log the detail server-side, return a generic 502.
	log.Printf("[embed] upstream Monad API call failed: %v", err)
	writeErr(w, http.StatusBadGateway, "upstream_error", "The upstream Monad API request failed.")
}
