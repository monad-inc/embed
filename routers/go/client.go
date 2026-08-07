package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// client is the hand-written Monad API client — the Go equivalent of the TS
// kit. It sequences Monad's /v1 + /v2 + /v3 calls; the router layer (embed.go)
// turns its results into the /embed contract's responses.
type client struct {
	apiKey       string
	apiBase      string
	hc           *http.Client
	pollAttempts int
	pollInterval time.Duration
}

func newClient(cfg Config) *client {
	return &client{
		apiKey:       cfg.APIKey,
		apiBase:      cfg.APIBase,
		hc:           &http.Client{Timeout: 30 * time.Second},
		pollAttempts: 15,
		pollInterval: 2 * time.Second,
	}
}

// componentKind is the contract's `kind` — the only two values any /embed route
// accepts. Mirrors the ComponentKind enum in embed.openapi.yaml.
type componentKind string

const (
	kindInput  componentKind = "input"
	kindOutput componentKind = "output"
)

// collection is the Monad path segment for a kind. Spelled out rather than
// appending "s", so the mapping is a fact rather than a coincidence of English.
func (k componentKind) collection() string {
	if k == kindInput {
		return "inputs"
	}
	return "outputs"
}

// pageSize is how many rows to request when draining a Monad list. Monad
// defaults `limit` to 10 and enforces no maximum, so this is a round-trip /
// response-size trade-off only: correctness comes from draining every page.
const pageSize = 200

// upstreamError carries a failed Monad call's status + detail. The router maps
// the status onto the contract's error model (404→not_found, 409→conflict,
// otherwise 502 upstream_error).
type upstreamError struct {
	status int
	detail string
}

func (e *upstreamError) Error() string { return e.detail }

// do performs an authenticated request and returns the raw JSON body. A >=400
// response becomes an error, which the router maps to 502 upstream_error.
func (c *client) do(ctx context.Context, method, path string, body any) ([]byte, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.apiBase+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "ApiKey "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		msg := string(data)
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, &upstreamError{status: resp.StatusCode, detail: fmt.Sprintf("%d %s: %s", resp.StatusCode, path, msg)}
	}
	return data, nil
}

func (c *client) mintSession(ctx context.Context, org string) (Session, error) {
	data, err := c.do(ctx, "POST", "/v3/sessions", map[string]any{
		"ttl_seconds": 1800, "organization_id": org,
	})
	if err != nil {
		return Session{}, err
	}
	var out struct {
		SessionToken string `json:"session_token"`
		ExpiresAt    string `json:"expires_at"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return Session{}, err
	}
	return Session{SessionToken: out.SessionToken, OrganizationID: org, ExpiresAt: out.ExpiresAt}, nil
}

func (c *client) listCatalog(ctx context.Context, kind componentKind, allow []string) ([]CatalogType, error) {
	data, err := c.do(ctx, "GET", "/v1/"+kind.collection(), nil)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		TypeID string `json:"type_id"`
		Name   string `json:"name"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	var allowSet map[string]bool
	if len(allow) > 0 {
		allowSet = make(map[string]bool, len(allow))
		for _, a := range allow {
			allowSet[a] = true
		}
	}
	out := []CatalogType{}
	for _, t := range raw {
		if allowSet != nil && !allowSet[t.TypeID] {
			continue
		}
		out = append(out, CatalogType{TypeID: t.TypeID, Name: t.Name})
	}
	return out, nil
}

// listConnectors returns every connector of a kind the tenant has configured.
//
// Monad pages this at limit=10 by default with no maximum, and the /embed
// contract returns a bare array with no pagination — so draining the pages is
// the router's job. A single large limit instead would silently truncate
// whichever tenant outgrows it.
func (c *client) listConnectors(ctx context.Context, org string, kind componentKind) ([]ConfiguredConnector, error) {
	key := kind.collection()
	out := []ConfiguredConnector{}
	for offset := 0; ; offset += pageSize {
		path := fmt.Sprintf("/v1/%s/%s?limit=%d&offset=%d", url.PathEscape(org), key, pageSize, offset)
		data, err := c.do(ctx, "GET", path, nil)
		if err != nil {
			return nil, err
		}
		// Rows come wrapped as { inputs: [...] } / { outputs: [...] } alongside a
		// `pagination` object. Decode only the connector array for this kind so
		// the sibling can't force a type mismatch; the array is `null`, not `[]`,
		// when the page is empty.
		var page map[string]json.RawMessage
		if err := json.Unmarshal(data, &page); err != nil {
			return nil, err
		}
		var rows []struct {
			ID   string `json:"id"`
			Type string `json:"type"`
			Name string `json:"name"`
		}
		if raw, ok := page[key]; ok {
			if err := json.Unmarshal(raw, &rows); err != nil {
				return nil, err
			}
		}
		for _, r := range rows {
			// Monad names the type slug `type` here; the contract calls it typeId.
			out = append(out, ConfiguredConnector{ID: r.ID, TypeID: r.Type, Name: r.Name})
		}
		// A short page is the last page. `total` only lets us stop one round trip
		// earlier when the count happens to divide evenly.
		if len(rows) < pageSize {
			return out, nil
		}
		var pg struct {
			Total int `json:"total"`
		}
		if raw, ok := page["pagination"]; ok {
			if err := json.Unmarshal(raw, &pg); err == nil && pg.Total > 0 && len(out) >= pg.Total {
				return out, nil
			}
		}
	}
}

type wireNode struct {
	Slug          string `json:"slug"`
	ComponentID   string `json:"component_id"`
	ComponentType string `json:"component_type"`
	Enabled       bool   `json:"enabled"`
}

// wirePipeline creates an input→output pipeline and polls until it reports
// Running (or Erroring). The shared primitive behind ingress and egress.
func (c *client) wirePipeline(ctx context.Context, org, inputID, outputID, name string) (BuiltPipeline, error) {
	body := map[string]any{
		"name":        name,
		"description": "Created when the connector was configured via embed",
		"enabled":     true,
		"nodes": []wireNode{
			{Slug: "in", ComponentID: inputID, ComponentType: "input", Enabled: true},
			{Slug: "out", ComponentID: outputID, ComponentType: "output", Enabled: true},
		},
		"edges": []map[string]any{{
			"from_node_instance_id": "in",
			"to_node_instance_id":   "out",
			"description":           "all records",
			"conditions":            map[string]any{"operator": "always"},
		}},
	}
	data, err := c.do(ctx, "POST", "/v2/"+url.PathEscape(org)+"/pipelines/", body)
	if err != nil {
		return BuiltPipeline{}, err
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(data, &created); err != nil {
		return BuiltPipeline{}, err
	}

	status := "Pending"
	for i := 0; i < c.pollAttempts; i++ {
		sd, err := c.do(ctx, "GET", "/v2/"+url.PathEscape(org)+"/pipelines/"+url.PathEscape(created.ID)+"/status", nil)
		if err != nil {
			return BuiltPipeline{}, err
		}
		var s struct {
			Status string `json:"status"`
		}
		if err := json.Unmarshal(sd, &s); err == nil && s.Status != "" {
			status = s.Status
		}
		if status == "Running" || status == "Erroring" {
			break
		}
		select {
		case <-ctx.Done():
			return BuiltPipeline{}, ctx.Err()
		case <-time.After(c.pollInterval):
		}
	}
	return BuiltPipeline{PipelineID: created.ID, OutputID: outputID, Status: status, Active: status == "Running"}, nil
}

// buildDevNull creates a throwaway dev/null output, then wires the input to it.
func (c *client) buildDevNull(ctx context.Context, org, inputID, name string) (BuiltPipeline, error) {
	data, err := c.do(ctx, "POST", "/v2/"+url.PathEscape(org)+"/outputs", map[string]any{
		// `type` is the canonical field; `output_type` is a deprecated alias.
		"type":        "dev-null",
		"name":        name + " → /dev/null",
		"description": "Auto-created sink for embed pipeline",
		"promise_id":  "",
		"config":      map[string]any{"settings": map[string]any{}, "secrets": map[string]any{}},
	})
	if err != nil {
		return BuiltPipeline{}, err
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return BuiltPipeline{}, err
	}
	return c.wirePipeline(ctx, org, inputID, out.ID, name)
}

type pipeNode struct {
	ComponentID   string `json:"component_id"`
	ComponentType string `json:"component_type"`
}

// pipelineNodes reads a pipeline's wiring. The detail response is flat — the
// nodes sit at the top level, not under a `config` envelope.
func (c *client) pipelineNodes(ctx context.Context, org, pipelineID string) ([]pipeNode, error) {
	data, err := c.do(ctx, "GET", "/v2/"+url.PathEscape(org)+"/pipelines/"+url.PathEscape(pipelineID), nil)
	if err != nil {
		return nil, err
	}
	var detail struct {
		Nodes []pipeNode `json:"nodes"`
	}
	if err := json.Unmarshal(data, &detail); err != nil {
		return nil, err
	}
	return detail.Nodes, nil
}

// pipelineFor resolves the pipeline a configured connector is wired into.
//
// Monad answers this directly: GET /v1/{org}/{kind}s/{id} returns
// `component_of`, the pipelines the component is a node of. Walking the org's
// pipeline list instead would be both O(n) and wrong — that list pages at 10,
// so any pipeline past the first page would read as "not connected".
//
// `component_of` carries no wiring (the datastore fills only a summary
// projection), so resolving the peer connector costs one further fetch.
// Returns an upstreamError with status 404 when the connector does not exist.
func (c *client) pipelineFor(ctx context.Context, org string, kind componentKind, connectorID string) (PipelineStatus, error) {
	data, err := c.do(ctx, "GET",
		"/v1/"+url.PathEscape(org)+"/"+kind.collection()+"/"+url.PathEscape(connectorID), nil)
	if err != nil {
		return PipelineStatus{}, err
	}
	var connector struct {
		ComponentOf []struct {
			ID      string `json:"id"`
			Enabled bool   `json:"enabled"`
		} `json:"component_of"`
	}
	if err := json.Unmarshal(data, &connector); err != nil {
		return PipelineStatus{}, err
	}
	if len(connector.ComponentOf) == 0 || connector.ComponentOf[0].ID == "" {
		return PipelineStatus{HasPipeline: false}, nil
	}
	p := connector.ComponentOf[0]
	ps := PipelineStatus{HasPipeline: true, Enabled: p.Enabled, PipelineID: p.ID}

	peer := kindOutput
	if kind == kindOutput {
		peer = kindInput
	}
	nodes, err := c.pipelineNodes(ctx, org, p.ID)
	if err != nil {
		return PipelineStatus{}, err
	}
	for _, n := range nodes {
		if n.ComponentType != string(peer) {
			continue
		}
		if kind == kindInput {
			ps.OutputID = n.ComponentID
		} else {
			ps.InputID = n.ComponentID
		}
		break
	}
	return ps, nil
}

// setEnabled flips the pipeline's enabled flag.
//
// PATCH is a true partial update: omitted fields keep their stored value and
// the node/edge graph is preserved untouched. Reading the pipeline and sending
// it back would replace the graph with whatever subset of fields the round trip
// happened to reproduce — silently dropping node `config_overrides` and edge
// `schema_detection_spec`.
func (c *client) setEnabled(ctx context.Context, org, pipelineID string, enabled bool) error {
	_, err := c.do(ctx, "PATCH", "/v2/"+url.PathEscape(org)+"/pipelines/"+url.PathEscape(pipelineID),
		map[string]any{"enabled": enabled})
	return err
}

// del removes a resource. Order matters at the call site: the pipeline
// references its input/output, so it must be deleted first.
func (c *client) del(ctx context.Context, path string) error {
	_, err := c.do(ctx, "DELETE", path, nil)
	return err
}
