package agentmode

import (
	"context"
	"fmt"

	"github.com/baziele/shelly/internal/history"
	"github.com/baziele/shelly/internal/outputcontext"
	"github.com/baziele/shelly/internal/context"
	"google.golang.org/adk/model"
	"google.golang.org/genai"
)

// Handler processes Agent Mode messages by maintaining a conversation with
// the LLM and returning the model's responses.
type Handler struct {
	LLM           model.LLM
	StaticContext *staticcontext.StaticContext
	History       *history.History

	// conversation holds the running history of user and model messages.
	conversation []*genai.Content
}

// Handle sends a user message to the LLM with full Session context and
// conversation history, then returns the model's response text.
func (h *Handler) Handle(message string) (string, error) {
	if len(h.conversation) == 0 {
		// First message: build the system prompt with context.
		prompt := h.buildPrompt(message)
		h.conversation = append(h.conversation, genai.NewContentFromText(prompt, genai.RoleUser))
	} else {
		h.conversation = append(h.conversation, genai.NewContentFromText(message, genai.RoleUser))
	}

	req := &model.LLMRequest{
		Contents: h.conversation,
	}

	var resp *model.LLMResponse
	var err error
	for r, e := range h.LLM.GenerateContent(context.Background(), req, false) {
		resp = r
		err = e
	}
	if err != nil {
		return "", fmt.Errorf("LLM error: %w", err)
	}

	if resp == nil || resp.Content == nil || len(resp.Content.Parts) == 0 {
		return "", fmt.Errorf("empty LLM response")
	}

	responseText := resp.Content.Parts[0].Text
	h.conversation = append(h.conversation, genai.NewContentFromText(responseText, genai.RoleModel))

	return responseText, nil
}

func (h *Handler) buildPrompt(message string) string {
	var prompt string

	prompt += "You are Shelly, an in-terminal AI assistant. You are in agent mode. "
	prompt += "The user has started a conversation with you from their terminal. "
	prompt += "Help them accomplish their task. You can ask clarifying questions, "
	prompt += "suggest commands, or provide explanations. Be concise but helpful.\n\n"

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

	prompt += fmt.Sprintf("\nUser: %s\n", message)

	return prompt
}
