package agentmode

import (
	"context"
	"iter"
	"os"
	"strings"
	"testing"

	"github.com/baziele/shelly/internal/history"
	"github.com/baziele/shelly/internal/context"
	"github.com/baziele/shelly/internal/tools"
	"google.golang.org/adk/model"
	"google.golang.org/genai"
)

// mockLLM is a test double that returns a fixed response.
type mockLLM struct {
	name     string
	response string
}

func (m *mockLLM) Name() string { return m.name }

func (m *mockLLM) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		content := genai.NewContentFromText(m.response, genai.RoleModel)
		resp := &model.LLMResponse{
			Content:      content,
			ModelVersion: "mock",
		}
		_ = yield(resp, nil)
	}
}

func TestHandlerReturnsResponse(t *testing.T) {
	llm := &mockLLM{
		response: "Hello! I can help you with that.",
	}

	h := &Handler{
		LLM:     llm,
		History: history.New(),
	}

	resp, err := h.Handle("hello agent")
	if err != nil {
		t.Fatalf("Handle error: %v", err)
	}
	if resp != "Hello! I can help you with that." {
		t.Errorf("Response = %q, want %q", resp, "Hello! I can help you with that.")
	}
}

func TestHandlerMaintainsConversationHistory(t *testing.T) {
	llm := &mockLLM{
		response: "Got it.",
	}

	h := &Handler{
		LLM:     llm,
		History: history.New(),
	}

	_, err := h.Handle("first message")
	if err != nil {
		t.Fatalf("Handle first message: %v", err)
	}

	_, err = h.Handle("second message")
	if err != nil {
		t.Fatalf("Handle second message: %v", err)
	}

	if len(h.conversation) != 4 {
		t.Errorf("conversation length = %d, want 4 (2 user + 2 model)", len(h.conversation))
	}
}

func TestHandlerBuildsPromptWithContext(t *testing.T) {
	var capturedPrompt string
	llm := &mockLLM{
		response: "ok",
	}
	captureLLM := &captureLLM{wrapped: llm, prompt: &capturedPrompt}

	hist := history.New()
	hist.Add("cd /tmp", 0, "", "")
	hist.Add("ls", 0, "file.txt", "file.txt")

	staticCtx := &staticcontext.StaticContext{
		WorkingDirectory: "/home/user",
		Shell:            "bash",
		OS:               "linux",
	}

	h := &Handler{
		LLM:           captureLLM,
		StaticContext: staticCtx,
		History:       hist,
	}

	_, err := h.Handle("do something")
	if err != nil {
		t.Fatalf("Handle error: %v", err)
	}

	if capturedPrompt == "" {
		t.Fatal("prompt was empty")
	}
	if !strings.Contains(capturedPrompt, "Current working directory: /home/user") {
		t.Errorf("prompt missing working directory")
	}
	if !strings.Contains(capturedPrompt, "cd /tmp") {
		t.Errorf("prompt missing command history")
	}
	if !strings.Contains(capturedPrompt, "file.txt") {
		t.Errorf("prompt missing output context")
	}
	if !strings.Contains(capturedPrompt, "User: do something") {
		t.Errorf("prompt missing user message")
	}
	if !strings.Contains(capturedPrompt, "agent mode") {
		t.Errorf("prompt missing agent mode indicator")
	}
}

type captureLLM struct {
	wrapped model.LLM
	prompt  *string
}

func (c *captureLLM) Name() string { return c.wrapped.Name() }

func (c *captureLLM) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	if len(req.Contents) > 0 && len(req.Contents[0].Parts) > 0 {
		*c.prompt = req.Contents[0].Parts[0].Text
	}
	return c.wrapped.GenerateContent(ctx, req, stream)
}

// mockToolLLM simulates an LLM that calls a tool on the first turn and then
// returns text after receiving the tool result.
type mockToolLLM struct {
	callIndex int
}

func (m *mockToolLLM) Name() string { return "mock-tool" }

func (m *mockToolLLM) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		m.callIndex++
		if m.callIndex == 1 {
			// First call: return a function call.
			fc := genai.NewPartFromFunctionCall("read_file", map[string]any{"path": "/tmp/test.txt"})
			fc.FunctionCall.ID = "call_1"
			content := genai.NewContentFromParts([]*genai.Part{fc}, genai.RoleModel)
			resp := &model.LLMResponse{Content: content, ModelVersion: "mock"}
			_ = yield(resp, nil)
			return
		}
		// Second call: return text after tool result.
		content := genai.NewContentFromText("File contains: hello", genai.RoleModel)
		resp := &model.LLMResponse{Content: content, ModelVersion: "mock"}
		_ = yield(resp, nil)
	}
}

func TestHandlerExecutesToolAndReturnsText(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/test.txt"
	if err := os.WriteFile(path, []byte("hello"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	llm := &mockToolLLM{}
	h := &Handler{
		LLM:     llm,
		History: history.New(),
		Tools:   tools.NewRegistry(),
	}

	resp, err := h.Handle("read the file")
	if err != nil {
		t.Fatalf("Handle error: %v", err)
	}
	if !strings.Contains(resp, "File contains: hello") {
		t.Errorf("response = %q, expected text after tool result", resp)
	}
}

func TestHandlerReturnsErrorWhenToolMissing(t *testing.T) {
	llm := &mockToolLLM{}
	h := &Handler{
		LLM:     llm,
		History: history.New(),
		// No Tools registry configured.
	}

	_, err := h.Handle("read the file")
	if err == nil {
		t.Fatal("expected error when tool registry missing")
	}
	if !strings.Contains(err.Error(), "no tool registry") {
		t.Errorf("error = %v, expected 'no tool registry'", err)
	}
}
