package embed_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	embed "github.com/monad-inc/embed/routers/go"
)

// recorder captures what the router actually sent upstream, so a test can
// assert on the request rather than only on the response.
type recorder struct {
	mu    sync.Mutex
	calls []string // "METHOD /path?query"
	body  map[string]string
}

func (rec *recorder) record(r *http.Request) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	call := r.Method + " " + r.URL.Path
	rec.calls = append(rec.calls, call+"?"+r.URL.RawQuery)
	if r.Body != nil {
		b, _ := io.ReadAll(r.Body)
		rec.body[call] = string(b)
	}
}

func (rec *recorder) count(prefix string) int {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	n := 0
	for _, c := range rec.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

// connectorsPage renders one page of `total` configured inputs the way Monad
// does: the rows under the `<kind>s` key, a `pagination` sibling, and null
// rather than [] once the page is empty.
func connectorsPage(total int, q map[string][]string) string {
	limit, _ := strconv.Atoi(first(q["limit"], "10"))
	offset, _ := strconv.Atoi(first(q["offset"], "0"))
	rows := []string{}
	for i := offset; i < offset+limit && i < total; i++ {
		rows = append(rows, fmt.Sprintf(`{"id":"cfg_%d","type":"aws-cloudtrail","name":"C%d"}`, i, i))
	}
	list := "null"
	if len(rows) > 0 {
		list = "[" + strings.Join(rows, ",") + "]"
	}
	return fmt.Sprintf(`{"inputs":%s,"pagination":{"limit":%d,"offset":%d,"total":%d}}`,
		list, limit, offset, total)
}

func first(values []string, fallback string) string {
	if len(values) == 0 {
		return fallback
	}
	return values[0]
}

// mockMonad stands in for the Monad API with just the endpoints these tests
// hit. `connectorTotal` sizes the configured-inputs list so paging is testable.
func mockMonad(t *testing.T, connectorTotal int) (*httptest.Server, *recorder) {
	t.Helper()
	rec := &recorder{body: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.record(r)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "POST" && r.URL.Path == "/v3/sessions":
			_, _ = w.Write([]byte(`{"session_token":"tok","expires_at":"2026-01-01T00:00:00Z"}`))
		case r.Method == "GET" && r.URL.Path == "/v1/inputs":
			_, _ = w.Write([]byte(`[{"type_id":"aws-cloudtrail","name":"AWS"},{"type_id":"secret","name":"Hidden"}]`))
		case r.Method == "GET" && r.URL.Path == "/v1/org_1/inputs":
			_, _ = w.Write([]byte(connectorsPage(connectorTotal, r.URL.Query())))
		case r.Method == "POST" && r.URL.Path == "/v2/org_1/outputs":
			_, _ = w.Write([]byte(`{"id":"out_devnull"}`))
		case r.Method == "POST" && r.URL.Path == "/v2/org_1/pipelines/":
			_, _ = w.Write([]byte(`{"id":"pipe_1"}`))
		case r.Method == "GET" && r.URL.Path == "/v2/org_1/pipelines/pipe_1/status":
			_, _ = w.Write([]byte(`{"status":"Running"}`))

		// A connector wired into pipe_1, and one wired into nothing.
		case r.Method == "GET" && r.URL.Path == "/v1/org_1/inputs/in_wired":
			_, _ = w.Write([]byte(`{"id":"in_wired","type":"aws-cloudtrail","name":"Wired",
				"component_of":[{"id":"pipe_1","name":"p","enabled":true}]}`))
		case r.Method == "GET" && r.URL.Path == "/v1/org_1/outputs/out_wired":
			_, _ = w.Write([]byte(`{"id":"out_wired","type":"s3","name":"Wired",
				"component_of":[{"id":"pipe_1","name":"p","enabled":false}]}`))
		case r.Method == "GET" && r.URL.Path == "/v1/org_1/inputs/in_bare":
			_, _ = w.Write([]byte(`{"id":"in_bare","type":"aws-cloudtrail","name":"Bare","component_of":[]}`))
		case r.Method == "GET" && r.URL.Path == "/v1/org_1/inputs/in_gone":
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)

		// The pipeline detail: flat, nodes at the top level.
		case r.Method == "GET" && r.URL.Path == "/v2/org_1/pipelines/pipe_1":
			_, _ = w.Write([]byte(`{"id":"pipe_1","name":"p","enabled":true,"nodes":[
				{"id":"n1","slug":"in","component_id":"in_wired","component_type":"input",
				 "config_overrides":{"keep":"me"}},
				{"id":"n2","slug":"out","component_id":"out_wired","component_type":"output"}],
				"edges":[{"from_node_instance_id":"in","to_node_instance_id":"out",
				 "schema_detection_spec":{"enabled":true}}]}`))
		case r.Method == "PATCH" && r.URL.Path == "/v2/org_1/pipelines/pipe_1":
			_, _ = w.Write([]byte(`{"id":"pipe_1"}`))

		case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/v1/org_1/"),
			r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/v2/org_1/"):
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected Monad call: %s %s", r.Method, r.URL.Path)
			http.Error(w, "unmocked", http.StatusInternalServerError)
		}
	}))
	return srv, rec
}

func newHandler(t *testing.T, monadURL string, over func(*embed.Config)) http.Handler {
	cfg := embed.Config{
		APIKey:           "k",
		APIBase:          monadURL,
		FrameOrigin:      "https://app.monad.com/embed",
		GetCustomerOrgID: func(r *http.Request) (string, error) { return "org_1", nil },
	}
	if over != nil {
		over(&cfg)
	}
	return embed.Router(cfg)
}

func do(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func TestGetConfig(t *testing.T) {
	h := newHandler(t, "http://unused", nil)
	rec := do(h, "GET", "/config", "")
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	var got map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["frameOrigin"] != "https://app.monad.com/embed" {
		t.Fatalf("frameOrigin = %q", got["frameOrigin"])
	}
}

func TestConfigDefaults(t *testing.T) {
	// APIBase + FrameOrigin omitted → production defaults.
	h := embed.Router(embed.Config{
		APIKey:           "k",
		GetCustomerOrgID: func(r *http.Request) (string, error) { return "org_1", nil },
	})
	rec := do(h, "GET", "/config", "")
	var got map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["apiBase"] != "https://app.monad.com/api" || got["frameOrigin"] != "https://app.monad.com/embed" {
		t.Fatalf("defaults not applied: %v", got)
	}
}

func TestSession(t *testing.T) {
	monad, _ := mockMonad(t, 0)
	defer monad.Close()
	rec := do(newHandler(t, monad.URL, nil), "POST", "/session", "")
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["sessionToken"] != "tok" || got["organizationId"] != "org_1" {
		t.Fatalf("session = %v", got)
	}
}

func TestCatalogAllowList(t *testing.T) {
	monad, _ := mockMonad(t, 0)
	defer monad.Close()
	h := newHandler(t, monad.URL, func(c *embed.Config) { c.CatalogAllow = []string{"aws-cloudtrail"} })
	rec := do(h, "GET", "/catalog?kind=input", "")
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	var got []map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if len(got) != 1 || got[0]["typeId"] != "aws-cloudtrail" {
		t.Fatalf("catalog = %v", got)
	}
}

func TestIngressDevNull(t *testing.T) {
	monad, _ := mockMonad(t, 0)
	defer monad.Close()
	rec := do(newHandler(t, monad.URL, nil), "POST", "/pipelines/ingress", `{"inputId":"in_1","name":"CT"}`)
	if rec.Code != 201 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["outputId"] != "out_devnull" || got["active"] != true {
		t.Fatalf("built = %v", got)
	}
}

func TestUnauthenticated(t *testing.T) {
	h := newHandler(t, "http://unused", func(c *embed.Config) {
		c.GetCustomerOrgID = func(r *http.Request) (string, error) { return "", nil }
	})
	rec := do(h, "POST", "/session", "")
	if rec.Code != 401 {
		t.Fatalf("status = %d", rec.Code)
	}
	var got map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["code"] != "unauthenticated" {
		t.Fatalf("code = %q", got["code"])
	}
}

func TestInvalidKind(t *testing.T) {
	h := newHandler(t, "http://unused", nil)
	rec := do(h, "GET", "/catalog?kind=nope", "")
	if rec.Code != 400 {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestNotFound(t *testing.T) {
	rec := do(newHandler(t, "http://unused", nil), "GET", "/nope", "")
	if rec.Code != 404 {
		t.Fatalf("status = %d", rec.Code)
	}
}

// A connector's pipeline is resolved from `component_of` plus one detail fetch
// for the peer — never by scanning the org's pipeline list, which pages at 10.
func TestPipelineStatusUsesComponentOf(t *testing.T) {
	for _, tc := range []struct {
		name, query   string
		wantPeerField string
		wantPeer      string
		wantEnabled   bool
	}{
		{"input", "connectorId=in_wired&kind=input", "outputId", "out_wired", true},
		{"output", "connectorId=out_wired&kind=output", "inputId", "in_wired", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			monad, rec := mockMonad(t, 0)
			defer monad.Close()
			res := do(newHandler(t, monad.URL, nil), "GET", "/pipelines?"+tc.query, "")
			if res.Code != 200 {
				t.Fatalf("status = %d body=%s", res.Code, res.Body.String())
			}
			var got map[string]any
			_ = json.Unmarshal(res.Body.Bytes(), &got)
			if got["hasPipeline"] != true || got["pipelineId"] != "pipe_1" {
				t.Fatalf("status = %v", got)
			}
			if got["enabled"] != tc.wantEnabled {
				t.Fatalf("enabled = %v, want %v", got["enabled"], tc.wantEnabled)
			}
			if got[tc.wantPeerField] != tc.wantPeer {
				t.Fatalf("%s = %v, want %q", tc.wantPeerField, got[tc.wantPeerField], tc.wantPeer)
			}
			if n := rec.count("GET /v2/org_1/pipelines?"); n != 0 {
				t.Fatalf("listed pipelines %d times; component_of makes the scan unnecessary", n)
			}
		})
	}
}

func TestPipelineStatusWithoutPipeline(t *testing.T) {
	monad, _ := mockMonad(t, 0)
	defer monad.Close()
	res := do(newHandler(t, monad.URL, nil), "GET", "/pipelines?connectorId=in_bare&kind=input", "")
	if res.Code != 200 {
		t.Fatalf("status = %d", res.Code)
	}
	var got map[string]any
	_ = json.Unmarshal(res.Body.Bytes(), &got)
	if got["hasPipeline"] != false || got["enabled"] != false {
		t.Fatalf("status = %v", got)
	}
}

// A connector that does not exist is the contract's 404, not a generic 502.
func TestPipelineStatusUnknownConnector(t *testing.T) {
	monad, _ := mockMonad(t, 0)
	defer monad.Close()
	res := do(newHandler(t, monad.URL, nil), "GET", "/pipelines?connectorId=in_gone&kind=input", "")
	if res.Code != 404 {
		t.Fatalf("status = %d body=%s", res.Code, res.Body.String())
	}
	var got map[string]string
	_ = json.Unmarshal(res.Body.Bytes(), &got)
	if got["code"] != "not_found" {
		t.Fatalf("code = %q", got["code"])
	}
}

// PATCH is a true partial update, so the body carries the flag and nothing
// else. Sending a rebuilt graph would drop whatever fields the round trip
// failed to reproduce (config_overrides, schema_detection_spec, …).
func TestSetEnabledSendsOnlyTheFlag(t *testing.T) {
	monad, rec := mockMonad(t, 0)
	defer monad.Close()
	res := do(newHandler(t, monad.URL, nil), "POST", "/pipelines/state",
		`{"pipelineId":"pipe_1","enabled":false}`)
	if res.Code != 204 {
		t.Fatalf("status = %d body=%s", res.Code, res.Body.String())
	}
	if got := rec.body["PATCH /v2/org_1/pipelines/pipe_1"]; got != `{"enabled":false}` {
		t.Fatalf("PATCH body = %s, want only the enabled flag", got)
	}
	if n := rec.count("GET /v2/org_1/pipelines/pipe_1?"); n != 0 {
		t.Fatalf("read the pipeline %d times; a partial PATCH needs no read-modify-write", n)
	}
}

// `type` is the canonical field on output create; `output_type` is deprecated.
func TestBuildDevNullSendsType(t *testing.T) {
	monad, rec := mockMonad(t, 0)
	defer monad.Close()
	if res := do(newHandler(t, monad.URL, nil), "POST", "/pipelines/ingress",
		`{"inputId":"in_1","name":"CT"}`); res.Code != 201 {
		t.Fatalf("status = %d body=%s", res.Code, res.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal([]byte(rec.body["POST /v2/org_1/outputs"]), &body)
	if body["type"] != "dev-null" {
		t.Fatalf("output create sent %v, want type=dev-null", body)
	}
	if _, legacy := body["output_type"]; legacy {
		t.Fatalf("output create still sends the deprecated output_type: %v", body)
	}
}

// Monad pages every list; the contract returns a bare array. The router has to
// drain the pages or it truncates the tenant's inventory.
func TestListConnectorsDrainsEveryPage(t *testing.T) {
	const total = 450 // spans three pages at the client's page size
	monad, rec := mockMonad(t, total)
	defer monad.Close()
	res := do(newHandler(t, monad.URL, nil), "GET", "/connectors?kind=input", "")
	if res.Code != 200 {
		t.Fatalf("status = %d body=%s", res.Code, res.Body.String())
	}
	var got []map[string]string
	_ = json.Unmarshal(res.Body.Bytes(), &got)
	if len(got) != total {
		t.Fatalf("got %d connectors, want %d — pages were not drained", len(got), total)
	}
	seen := map[string]bool{}
	for _, c := range got {
		if seen[c["id"]] {
			t.Fatalf("duplicate connector %q across pages", c["id"])
		}
		seen[c["id"]] = true
	}
	if n := rec.count("GET /v1/org_1/inputs?"); n < 2 {
		t.Fatalf("made %d list calls for %d rows; expected several pages", n, total)
	}
}

// An empty list comes back as null, not [], and must still yield an empty
// array rather than a decode error or a JSON `null` body.
func TestListConnectorsHandlesNullPage(t *testing.T) {
	monad, _ := mockMonad(t, 0)
	defer monad.Close()
	res := do(newHandler(t, monad.URL, nil), "GET", "/connectors?kind=input", "")
	if res.Code != 200 {
		t.Fatalf("status = %d", res.Code)
	}
	if body := strings.TrimSpace(res.Body.String()); body != "[]" {
		t.Fatalf("body = %s, want []", body)
	}
}

// Removing an input tears down the pipeline and the input, and the throwaway
// sink with them — but never the tenant's provisioned store.
func TestRemoveKeepsProvisionedStore(t *testing.T) {
	for _, tc := range []struct {
		name        string
		provisioned string
		wantDeleted bool
	}{
		{"throwaway sink is removed", "", true},
		{"provisioned store is kept", "out_wired", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			monad, rec := mockMonad(t, 0)
			defer monad.Close()
			h := newHandler(t, monad.URL, func(c *embed.Config) {
				c.GetProvisionedComponents = func(string) embed.Provision {
					return embed.Provision{DestinationOutputID: tc.provisioned}
				}
			})
			if res := do(h, "POST", "/pipelines/remove",
				`{"connectorId":"in_wired","kind":"input"}`); res.Code != 204 {
				t.Fatalf("status = %d body=%s", res.Code, res.Body.String())
			}
			if rec.count("DELETE /v2/org_1/pipelines/pipe_1?") != 1 {
				t.Fatal("the pipeline must be deleted first — it references the connectors")
			}
			if rec.count("DELETE /v1/org_1/inputs/in_wired?") != 1 {
				t.Fatal("the input was not deleted")
			}
			if got := rec.count("DELETE /v1/org_1/outputs/out_wired?") == 1; got != tc.wantDeleted {
				t.Fatalf("output deleted = %v, want %v", got, tc.wantDeleted)
			}
		})
	}
}
