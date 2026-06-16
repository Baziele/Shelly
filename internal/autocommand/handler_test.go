package autocommand

import (
	"context"
	"iter"
	"strings"
	"testing"

	"github.com/baziele/shelly/internal/history"
	"github.com/baziele/shelly/internal/context"
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

func TestHandlerReturnsCommand(t *testing.T) {
	llm := &mockLLM{
		response: `{"command": "ls -la"}`,
	}

	h := &Handler{
		LLM:     llm,
		History: history.New(),
	}

	cmd, err := h.Handle("list files")
	if err != nil {
		t.Fatalf("Handle error: %v", err)
	}
	if cmd != "ls -la" {
		t.Errorf("Command = %q, want %q", cmd, "ls -la")
	}
}

func TestHandlerParsesMarkdownJSONBlock(t *testing.T) {
	llm := &mockLLM{
		response: "```json\n{\"command\": \"pwd\"}\n```",
	}

	h := &Handler{
		LLM:     llm,
		History: history.New(),
	}

	cmd, err := h.Handle("where am i")
	if err != nil {
		t.Fatalf("Handle error: %v", err)
	}
	if cmd != "pwd" {
		t.Errorf("Command = %q, want %q", cmd, "pwd")
	}
}

func TestHandlerFallsBackToPlainText(t *testing.T) {
	llm := &mockLLM{
		response: "ls -la",
	}

	h := &Handler{
		LLM:     llm,
		History: history.New(),
	}

	cmd, err := h.Handle("list files")
	if err != nil {
		t.Fatalf("Handle error: %v", err)
	}
	if cmd != "ls -la" {
		t.Errorf("Command = %q, want %q", cmd, "ls -la")
	}
}

func TestHandlerBuildsPromptWithContext(t *testing.T) {
	var capturedPrompt string
	llm := &mockLLM{
		response: `{"command": "ls"}`,
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

	_, err := h.Handle("show files")
	if err != nil {
		t.Fatalf("Handle error: %v", err)
	}

	if capturedPrompt == "" {
		t.Fatal("prompt was empty")
	}
	if !contains(capturedPrompt, "Current working directory: /home/user") {
		t.Errorf("prompt missing working directory")
	}
	if !contains(capturedPrompt, "cd /tmp") {
		t.Errorf("prompt missing command history")
	}
	if !contains(capturedPrompt, "file.txt") {
		t.Errorf("prompt missing output context")
	}
	if !contains(capturedPrompt, "Task: show files") {
		t.Errorf("prompt missing task")
	}
	if !contains(capturedPrompt, `"command"`) {
		t.Errorf("prompt missing JSON format instruction")
	}
	if !contains(capturedPrompt, "single shell command") {
		t.Errorf("prompt missing single-command constraint")
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

func contains(s, substr string) bool {
	return strings.Contains(s, substr)
}
