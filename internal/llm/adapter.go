// Package llm provides an OpenAI-compatible LLM adapter for the ADK model.LLM interface.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"iter"
	"net/http"
	"os"

	"google.golang.org/adk/model"
	"google.golang.org/genai"
)

// OpenAIAdapter implements model.LLM by sending requests to an OpenAI-compatible endpoint.
type OpenAIAdapter struct {
	baseURL string
	apiKey  string
	model   string
	client  *http.Client
}

// NewOpenAIAdapter creates an adapter from environment variables.
func NewOpenAIAdapter() *OpenAIAdapter {
	baseURL := os.Getenv("LLM_BASE_URL")
	apiKey := os.Getenv("LLM_API_KEY")
	model := os.Getenv("LLM_MODEL")

	if baseURL == "" {
		baseURL = "https://opencode.ai/zen/go/v1"
	}
	if apiKey == "" {
		apiKey = "__REMOVED_SECRET__"
	}
	if model == "" {
		model = "deepseek-v4-flash"
	}

	return &OpenAIAdapter{
		baseURL: baseURL,
		apiKey:  apiKey,
		model:   model,
		client:  http.DefaultClient,
	}
}

// Name returns the adapter name.
func (a *OpenAIAdapter) Name() string {
	return "openai-compatible"
}

// GenerateContent sends a request to the OpenAI-compatible endpoint and returns the response.
func (a *OpenAIAdapter) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		resp, err := a.generate(ctx, req, stream)
		if !yield(resp, err) {
			return
		}
	}
}

func (a *OpenAIAdapter) generate(ctx context.Context, req *model.LLMRequest, stream bool) (*model.LLMResponse, error) {
	modelName := a.model
	if req.Model != "" {
		modelName = req.Model
	}

	messages, err := contentsToMessages(req.Contents)
	if err != nil {
		return nil, err
	}

	body := openAIRequest{
		Model:    modelName,
		Messages: messages,
		Stream:   stream,
	}

	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", a.baseURL+"/chat/completions", bytes.NewReader(bodyJSON))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	if a.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+a.apiKey)
	}

	httpResp, err := a.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("send request: %w", err)
	}
	defer httpResp.Body.Close()

	respBody, err := io.ReadAll(httpResp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if httpResp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", httpResp.StatusCode, string(respBody))
	}

	var openaiResp openAIResponse
	if err := json.Unmarshal(respBody, &openaiResp); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}

	if len(openaiResp.Choices) == 0 {
		return nil, fmt.Errorf("no choices in response")
	}

	choice := openaiResp.Choices[0]
	content := genai.NewContentFromText(choice.Message.Content, genai.RoleModel)

	return &model.LLMResponse{
		Content:      content,
		ModelVersion: openaiResp.Model,
	}, nil
}

func contentsToMessages(contents []*genai.Content) ([]openAIMessage, error) {
	messages := make([]openAIMessage, 0, len(contents))
	for _, c := range contents {
		role := c.Role
		if role == "model" {
			role = "assistant"
		}

		var text string
		for _, part := range c.Parts {
			if part.Text != "" {
				text += part.Text
			}
		}

		messages = append(messages, openAIMessage{
			Role:    role,
			Content: text,
		})
	}
	return messages, nil
}

type openAIRequest struct {
	Model    string          `json:"model"`
	Messages []openAIMessage `json:"messages"`
	Stream   bool            `json:"stream,omitempty"`
}

type openAIMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openAIResponse struct {
	Model    string        `json:"model"`
	Choices  []openAIChoice `json:"choices"`
}

type openAIChoice struct {
	Message openAIMessage `json:"message"`
}
