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

// esc URL-encodes a single path segment so browser-supplied ids can't inject
// query params or traverse the path (`/`, `?`, `#` are neutralised).
var esc = url.PathEscape

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

func (c *client) listCatalog(ctx context.Context, kind string, allow []string) ([]CatalogType, error) {
	data, err := c.do(ctx, "GET", "/v1/"+kind+"s", nil)
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

func (c *client) listConnectors(ctx context.Context, org, kind string) ([]ConfiguredConnector, error) {
	data, err := c.do(ctx, "GET", "/v1/"+esc(org)+"/"+kind+"s?limit=1000&offset=0", nil)
	if err != nil {
		return nil, err
	}
	// Rows come wrapped as { inputs: [...] } / { outputs: [...] } alongside other
	// keys (e.g. a `pagination` object). Decode only the connector array for this
	// kind so sibling keys don't force a type mismatch; carry the type slug as
	// `type`, normalized to typeId for the /embed contract.
	var page map[string]json.RawMessage
	if err := json.Unmarshal(data, &page); err != nil {
		return nil, err
	}
	var rows []struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if raw, ok := page[kind+"s"]; ok {
		if err := json.Unmarshal(raw, &rows); err != nil {
			return nil, err
		}
	}
	out := []ConfiguredConnector{}
	for _, r := range rows {
		out = append(out, ConfiguredConnector{ID: r.ID, TypeID: r.Type, Name: r.Name})
	}
	return out, nil
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
	data, err := c.do(ctx, "POST", "/v2/"+esc(org)+"/pipelines/", body)
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
		sd, err := c.do(ctx, "GET", "/v2/"+esc(org)+"/pipelines/"+esc(created.ID)+"/status", nil)
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
	data, err := c.do(ctx, "POST", "/v2/"+esc(org)+"/outputs", map[string]any{
		"output_type": "dev-null",
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

type pipeSummary struct {
	ID string `json:"id"`
}

type nodeFull struct {
	ID            string `json:"id"`
	Slug          string `json:"slug"`
	ComponentID   string `json:"component_id"`
	ComponentType string `json:"component_type"`
	Enabled       *bool  `json:"enabled"`
}

type edgeFull struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	From        string          `json:"from_node_instance_id"`
	To          string          `json:"to_node_instance_id"`
	Disabled    *bool           `json:"disabled"`
	Conditions  json.RawMessage `json:"conditions"`
}

type pipeBody struct {
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Enabled     bool       `json:"enabled"`
	Nodes       []nodeFull `json:"nodes"`
	Edges       []edgeFull `json:"edges"`
}

// pipeDetail handles both the wrapped ({ config: {...} }) and flat detail shapes.
type pipeDetail struct {
	Config *pipeBody `json:"config"`
	pipeBody
}

func (c *client) listPipelines(ctx context.Context, org string) ([]pipeSummary, error) {
	data, err := c.do(ctx, "GET", "/v2/"+esc(org)+"/pipelines/", nil)
	if err != nil {
		return nil, err
	}
	var arr []pipeSummary
	if json.Unmarshal(data, &arr) == nil && len(arr) > 0 {
		return arr, nil
	}
	var obj struct {
		Pipelines []pipeSummary `json:"pipelines"`
		Data      []pipeSummary `json:"data"`
	}
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil, err
	}
	if len(obj.Pipelines) > 0 {
		return obj.Pipelines, nil
	}
	return obj.Data, nil
}

func (c *client) getPipeline(ctx context.Context, org, id string) (*pipeBody, error) {
	data, err := c.do(ctx, "GET", "/v2/"+esc(org)+"/pipelines/"+esc(id), nil)
	if err != nil {
		return nil, err
	}
	var d pipeDetail
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, err
	}
	if d.Config != nil {
		return d.Config, nil
	}
	b := d.pipeBody
	return &b, nil
}

// statusByInput resolves the pipeline an input feeds, knowing only the input id.
func (c *client) statusByInput(ctx context.Context, org, inputID string) (PipelineStatus, error) {
	sums, err := c.listPipelines(ctx, org)
	if err != nil {
		return PipelineStatus{}, err
	}
	for _, s := range sums {
		if s.ID == "" {
			continue
		}
		body, err := c.getPipeline(ctx, org, s.ID)
		if err != nil {
			continue
		}
		var inNode, outNode *nodeFull
		for i := range body.Nodes {
			n := &body.Nodes[i]
			if n.ComponentType == "input" && n.ComponentID == inputID {
				inNode = n
			}
			if n.ComponentType == "output" {
				outNode = n
			}
		}
		if inNode == nil {
			continue
		}
		ps := PipelineStatus{HasPipeline: true, Enabled: body.Enabled, PipelineID: s.ID}
		if outNode != nil {
			ps.OutputID = outNode.ComponentID
		}
		return ps, nil
	}
	return PipelineStatus{HasPipeline: false}, nil
}

// findByOutput resolves the pipeline feeding an output — the egress counterpart.
func (c *client) findByOutput(ctx context.Context, org, outputID string) (PipelineStatus, error) {
	sums, err := c.listPipelines(ctx, org)
	if err != nil {
		return PipelineStatus{}, err
	}
	for _, s := range sums {
		if s.ID == "" {
			continue
		}
		body, err := c.getPipeline(ctx, org, s.ID)
		if err != nil {
			continue
		}
		var inNode, outNode *nodeFull
		for i := range body.Nodes {
			n := &body.Nodes[i]
			if n.ComponentType == "output" && n.ComponentID == outputID {
				outNode = n
			}
			if n.ComponentType == "input" {
				inNode = n
			}
		}
		if outNode == nil {
			continue
		}
		ps := PipelineStatus{HasPipeline: true, Enabled: body.Enabled, PipelineID: s.ID}
		if inNode != nil {
			ps.InputID = inNode.ComponentID
		}
		return ps, nil
	}
	return PipelineStatus{HasPipeline: false}, nil
}

// setEnabled flips the pipeline's enabled flag. The PATCH endpoint replaces the
// whole config, so this reads the current pipeline and sends it back unchanged
// except for the flag.
func (c *client) setEnabled(ctx context.Context, org, pipelineID string, enabled bool) error {
	body, err := c.getPipeline(ctx, org, pipelineID)
	if err != nil {
		return err
	}
	nodes := make([]map[string]any, 0, len(body.Nodes))
	for _, n := range body.Nodes {
		en := true
		if n.Enabled != nil {
			en = *n.Enabled
		}
		nodes = append(nodes, map[string]any{
			"id": n.ID, "slug": n.Slug, "component_id": n.ComponentID,
			"component_type": n.ComponentType, "enabled": en,
		})
	}
	edges := make([]map[string]any, 0, len(body.Edges))
	for _, e := range body.Edges {
		dis := false
		if e.Disabled != nil {
			dis = *e.Disabled
		}
		edges = append(edges, map[string]any{
			"name": e.Name, "description": e.Description,
			"from_node_instance_id": e.From, "to_node_instance_id": e.To,
			"disabled": dis, "conditions": e.Conditions,
		})
	}
	_, err = c.do(ctx, "PATCH", "/v2/"+esc(org)+"/pipelines/"+esc(pipelineID), map[string]any{
		"name": body.Name, "description": body.Description, "enabled": enabled,
		"nodes": nodes, "edges": edges,
	})
	return err
}

// del removes a resource. Order matters at the call site: the pipeline
// references its input/output, so it must be deleted first.
func (c *client) del(ctx context.Context, path string) error {
	_, err := c.do(ctx, "DELETE", path, nil)
	return err
}
