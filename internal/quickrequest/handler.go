package quickrequest

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/baziele/shelly/internal/history"
	"github.com/baziele/shelly/internal/outputcontext"
	"github.com/baziele/shelly/internal/context"
	"google.golang.org/adk/model"
	"google.golang.org/genai"
)

// Handler processes Quick Request questions by sending them to an LLM with
// Session context and returning the structured response.
type Handler struct {
	LLM           model.LLM
	StaticContext *staticcontext.StaticContext
	History       *history.History
}

// Response is the structured JSON format the LLM returns for Quick Request.
type Response struct {
	Explanation string `json:"explanation"`
	Command     string `json:"command"`
}

// Handle builds a prompt with Session context, sends it to the LLM, and
// returns the parsed response.
func (h *Handler) Handle(question string) (*Response, error) {
	prompt := h.buildPrompt(question)

	req := &model.LLMRequest{
		Contents: []*genai.Content{
			genai.NewContentFromText(prompt, genai.RoleUser),
		},
	}

	var resp *model.LLMResponse
	var err error
	for r, e := range h.LLM.GenerateContent(context.Background(), req, false) {
		resp = r
		err = e
	}
	if err != nil {
		return nil, fmt.Errorf("LLM error: %w", err)
	}

	if resp == nil || resp.Content == nil || len(resp.Content.Parts) == 0 {
		return nil, fmt.Errorf("empty LLM response")
	}

	return parseResponse(resp.Content.Parts[0].Text)
}

func (h *Handler) buildPrompt(question string) string {
	var prompt string

	prompt += "You are Shelly, an in-terminal AI assistant.\n\n"
	prompt += "The user has asked a question in their terminal. Answer concisely.\n\n"

	if h.StaticContext != nil {
		prompt += fmt.Sprintf("Current working directory: %s\n", h.StaticContext.WorkingDirectory)
		prompt += fmt.Sprintf("Shell: %s\n", h.StaticContext.Shell)
		prompt += fmt.Sprintf("OS: %s\n", h.StaticContext.OS)
	}

	if h.History != nil {
		entries := h.History.Entries()
		if len(entries) > 0 {
			prompt += "\nRecent commands:\n"
			for i, e := range entries {
				if i >= 10 {
					break
				}
				prompt += fmt.Sprintf("- %s (exit %d)\n", e.RawInput, e.ExitCode)
			}
		}

		outputs := outputcontext.Build(entries, 6144)
		if len(outputs) > 0 {
			prompt += "\nRecent command output:\n"
			for _, out := range outputs {
				prompt += out + "\n"
			}
		}
	}

	prompt += fmt.Sprintf("\nQuestion: %s\n\n", question)
	prompt += "Return your answer in this exact JSON format:\n"
	prompt += `{"explanation": "your answer here", "command": "optional shell command"}` + "\n"
	prompt += "If no command is needed, leave command as empty string."

	return prompt
}

func parseResponse(text string) (*Response, error) {
	// Try to parse the entire response as JSON.
	var resp Response
	if err := json.Unmarshal([]byte(text), &resp); err == nil {
		return &resp, nil
	}

	// If that fails, try to extract JSON from a markdown code block.
	if idx := strings.Index(text, "```json"); idx != -1 {
		start := idx + len("```json")
		if end := strings.Index(text[start:], "```"); end != -1 {
			if err := json.Unmarshal([]byte(text[start : start+end]), &resp); err == nil {
				return &resp, nil
			}
		}
	}
	if idx := strings.Index(text, "```"); idx != -1 {
		start := idx + len("```")
		if end := strings.Index(text[start:], "```"); end != -1 {
			if err := json.Unmarshal([]byte(text[start : start+end]), &resp); err == nil {
				return &resp, nil
			}
		}
	}

	// Fallback: treat the entire text as the explanation.
	return &Response{Explanation: text}, nil
}
