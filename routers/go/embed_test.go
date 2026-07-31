package embed_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	embed "github.com/monad-inc/embed/routers/go"
)

// mockMonad stands in for the Monad API with just the endpoints these tests hit.
func mockMonad(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "POST" && r.URL.Path == "/v3/sessions":
			_, _ = w.Write([]byte(`{"session_token":"tok","expires_at":"2026-01-01T00:00:00Z"}`))
		case r.Method == "GET" && r.URL.Path == "/v1/inputs":
			_, _ = w.Write([]byte(`[{"type_id":"aws-cloudtrail","name":"AWS"},{"type_id":"secret","name":"Hidden"}]`))
		case r.Method == "POST" && r.URL.Path == "/v2/org_1/outputs":
			_, _ = w.Write([]byte(`{"id":"out_devnull"}`))
		case r.Method == "POST" && r.URL.Path == "/v2/org_1/pipelines/":
			_, _ = w.Write([]byte(`{"id":"pipe_1"}`))
		case r.Method == "GET" && r.URL.Path == "/v2/org_1/pipelines/pipe_1/status":
			_, _ = w.Write([]byte(`{"status":"Running"}`))
		default:
			t.Errorf("unexpected Monad call: %s %s", r.Method, r.URL.Path)
			http.Error(w, "unmocked", http.StatusInternalServerError)
		}
	}))
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
	monad := mockMonad(t)
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
	monad := mockMonad(t)
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
	monad := mockMonad(t)
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
