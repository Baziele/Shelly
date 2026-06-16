package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"google.golang.org/adk/model"
	"google.golang.org/genai"
)

func TestOpenAIAdapterReadsEnvVars(t *testing.T) {
	os.Setenv("LLM_BASE_URL", "http://example.com")
	os.Setenv("LLM_API_KEY", "test-key")
	os.Setenv("LLM_MODEL", "test-model")
	defer os.Unsetenv("LLM_BASE_URL")
	defer os.Unsetenv("LLM_API_KEY")
	defer os.Unsetenv("LLM_MODEL")

	adapter := NewOpenAIAdapter()

	if adapter.baseURL != "http://example.com" {
		t.Errorf("baseURL = %q, want %q", adapter.baseURL, "http://example.com")
	}
	if adapter.apiKey != "test-key" {
		t.Errorf("apiKey = %q, want %q", adapter.apiKey, "test-key")
	}
	if adapter.model != "test-model" {
		t.Errorf("model = %q, want %q", adapter.model, "test-model")
	}
}

func TestOpenAIAdapterName(t *testing.T) {
	adapter := NewOpenAIAdapter()
	if adapter.Name() != "openai-compatible" {
		t.Errorf("Name() = %q, want %q", adapter.Name(), "openai-compatible")
	}
}

func TestOpenAIAdapterSendsRequestAndReturnsResponse(t *testing.T) {
	var receivedRequest openAIRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %q, want %q", r.URL.Path, "/chat/completions")
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer test-key" {
			t.Errorf("Authorization = %q, want %q", auth, "Bearer test-key")
		}

		if err := json.NewDecoder(r.Body).Decode(&receivedRequest); err != nil {
			t.Fatalf("decode request: %v", err)
		}

		resp := openAIResponse{
			Model: "gpt-4",
			Choices: []openAIChoice{
				{Message: openAIMessage{Role: "assistant", Content: "Hello, world!"}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	adapter := &OpenAIAdapter{
		baseURL: server.URL,
		apiKey:  "test-key",
		model:   "test-model",
		client:  server.Client(),
	}

	req := &model.LLMRequest{
		Model: "test-model",
		Contents: []*genai.Content{
			genai.NewContentFromText("Say hello", genai.RoleUser),
		},
	}

	var resp *model.LLMResponse
	var err error
	for r, e := range adapter.GenerateContent(context.Background(), req, false) {
		resp = r
		err = e
	}

	if err != nil {
		t.Fatalf("GenerateContent error: %v", err)
	}
	if resp == nil {
		t.Fatal("resp is nil")
	}
	if resp.ModelVersion != "gpt-4" {
		t.Errorf("ModelVersion = %q, want %q", resp.ModelVersion, "gpt-4")
	}
	if resp.Content == nil {
		t.Fatal("Content is nil")
	}
	if len(resp.Content.Parts) != 1 {
		t.Fatalf("len(Parts) = %d, want 1", len(resp.Content.Parts))
	}
	if resp.Content.Parts[0].Text != "Hello, world!" {
		t.Errorf("Text = %q, want %q", resp.Content.Parts[0].Text, "Hello, world!")
	}
	if resp.Content.Role != "model" {
		t.Errorf("Role = %q, want %q", resp.Content.Role, "model")
	}

	if receivedRequest.Model != "test-model" {
		t.Errorf("received model = %q, want %q", receivedRequest.Model, "test-model")
	}
	if len(receivedRequest.Messages) != 1 {
		t.Fatalf("received messages = %d, want 1", len(receivedRequest.Messages))
	}
	if receivedRequest.Messages[0].Role != "user" {
		t.Errorf("received role = %q, want %q", receivedRequest.Messages[0].Role, "user")
	}
	if receivedRequest.Messages[0].Content != "Say hello" {
		t.Errorf("received content = %q, want %q", receivedRequest.Messages[0].Content, "Say hello")
	}
}

func TestOpenAIAdapterReturnsErrorOnHTTPFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error": "invalid key"}`))
	}))
	defer server.Close()

	adapter := &OpenAIAdapter{
		baseURL: server.URL,
		apiKey:  "bad-key",
		model:   "test-model",
		client:  server.Client(),
	}

	req := &model.LLMRequest{
		Contents: []*genai.Content{
			genai.NewContentFromText("Hi", genai.RoleUser),
		},
	}

	var err error
	for _, e := range adapter.GenerateContent(context.Background(), req, false) {
		err = e
	}

	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err.Error() != "HTTP 401: {\"error\": \"invalid key\"}" {
		t.Errorf("error = %q, want HTTP 401 error", err.Error())
	}
}

func TestOpenAIAdapterReturnsErrorOnNoChoices(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := openAIResponse{
			Model:   "gpt-4",
			Choices: []openAIChoice{},
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	adapter := &OpenAIAdapter{
		baseURL: server.URL,
		apiKey:  "test-key",
		model:   "test-model",
		client:  server.Client(),
	}

	req := &model.LLMRequest{
		Contents: []*genai.Content{
			genai.NewContentFromText("Hi", genai.RoleUser),
		},
	}

	var err error
	for _, e := range adapter.GenerateContent(context.Background(), req, false) {
		err = e
	}

	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err.Error() != "no choices in response" {
		t.Errorf("error = %q, want %q", err.Error(), "no choices in response")
	}
}

func TestOpenAIAdapterUsesReqModelOverride(t *testing.T) {
	var receivedRequest openAIRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&receivedRequest)
		resp := openAIResponse{
			Model: "gpt-4",
			Choices: []openAIChoice{
				{Message: openAIMessage{Role: "assistant", Content: "ok"}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	adapter := &OpenAIAdapter{
		baseURL: server.URL,
		apiKey:  "test-key",
		model:   "env-model",
		client:  server.Client(),
	}

	req := &model.LLMRequest{
		Model: "req-model",
		Contents: []*genai.Content{
			genai.NewContentFromText("Hi", genai.RoleUser),
		},
	}

	var err error
	for _, e := range adapter.GenerateContent(context.Background(), req, false) {
		err = e
	}

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if receivedRequest.Model != "req-model" {
		t.Errorf("model = %q, want %q", receivedRequest.Model, "req-model")
	}
}

func TestOpenAIAdapterMapsModelRoleToAssistant(t *testing.T) {
	var receivedRequest openAIRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&receivedRequest)
		resp := openAIResponse{
			Model: "gpt-4",
			Choices: []openAIChoice{
				{Message: openAIMessage{Role: "assistant", Content: "ok"}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	adapter := &OpenAIAdapter{
		baseURL: server.URL,
		apiKey:  "test-key",
		model:   "test-model",
		client:  server.Client(),
	}

	req := &model.LLMRequest{
		Contents: []*genai.Content{
			genai.NewContentFromText("prev", genai.RoleModel),
		},
	}

	var err error
	for _, e := range adapter.GenerateContent(context.Background(), req, false) {
		err = e
	}

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(receivedRequest.Messages) != 1 {
		t.Fatalf("messages = %d, want 1", len(receivedRequest.Messages))
	}
	if receivedRequest.Messages[0].Role != "assistant" {
		t.Errorf("role = %q, want %q", receivedRequest.Messages[0].Role, "assistant")
	}
}
