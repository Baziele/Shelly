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
	"strings"

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

	// Convert genai tools to OpenAI format.
	if toolsAny, ok := req.Tools["function_declarations"]; ok {
		if tools, ok := toolsAny.([]*genai.Tool); ok {
			body.Tools = genaiToolsToOpenAI(tools)
		}
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
	content, err := openAIMessageToContent(choice.Message)
	if err != nil {
		return nil, err
	}

	return &model.LLMResponse{
		Content:      content,
		ModelVersion: openaiResp.Model,
	}, nil
}

func genaiToolsToOpenAI(tools []*genai.Tool) []openAITool {
	var out []openAITool
	for _, tool := range tools {
		for _, decl := range tool.FunctionDeclarations {
			params := schemaToMap(decl.Parameters)
			out = append(out, openAITool{
				Type: "function",
				Function: openAIFunction{
					Name:        decl.Name,
					Description: decl.Description,
					Parameters:  params,
				},
			})
		}
	}
	return out
}

func schemaToMap(s *genai.Schema) map[string]any {
	if s == nil {
		return nil
	}
	m := map[string]any{
		"type": strings.ToLower(string(s.Type)),
	}
	if s.Description != "" {
		m["description"] = s.Description
	}
	if s.Properties != nil {
		props := make(map[string]any, len(s.Properties))
		for k, v := range s.Properties {
			props[k] = schemaToMap(v)
		}
		m["properties"] = props
	}
	if len(s.Required) > 0 {
		m["required"] = s.Required
	}
	return m
}

func contentsToMessages(contents []*genai.Content) ([]openAIMessage, error) {
	messages := make([]openAIMessage, 0, len(contents))
	for _, c := range contents {
		role := c.Role
		if role == "model" {
			role = "assistant"
		}
		if role == "user" {
			role = "user"
		}

		msg := openAIMessage{Role: role}
		for _, part := range c.Parts {
			if part.Text != "" {
				msg.Content += part.Text
			}
			if part.FunctionCall != nil {
				msg.ToolCalls = append(msg.ToolCalls, openAIToolCall{
					ID:   part.FunctionCall.ID,
					Type: "function",
					Function: openAIToolFunction{
						Name:      part.FunctionCall.Name,
						Arguments: toJSON(part.FunctionCall.Args),
					},
				})
			}
			if part.FunctionResponse != nil {
				msg = openAIMessage{
					Role:       "tool",
					ToolCallID: part.FunctionResponse.ID,
					Content:    toJSON(part.FunctionResponse.Response),
				}
			}
		}
		messages = append(messages, msg)
	}
	return messages, nil
}

func openAIMessageToContent(m openAIMessage) (*genai.Content, error) {
	parts := []*genai.Part{}

	if m.Content != "" {
		parts = append(parts, genai.NewPartFromText(m.Content))
	}

	for _, tc := range m.ToolCalls {
		var args map[string]any
		if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
			return nil, fmt.Errorf("parse tool call arguments: %w", err)
		}
		fc := genai.NewPartFromFunctionCall(tc.Function.Name, args)
		fc.FunctionCall.ID = tc.ID
		parts = append(parts, fc)
	}

	return genai.NewContentFromParts(parts, genai.RoleModel), nil
}

func toJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}

type openAIRequest struct {
	Model    string          `json:"model"`
	Messages []openAIMessage `json:"messages"`
	Stream   bool            `json:"stream,omitempty"`
	Tools    []openAITool    `json:"tools,omitempty"`
}

type openAITool struct {
	Type     string           `json:"type"`
	Function openAIFunction   `json:"function"`
}

type openAIFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

type openAIMessage struct {
	Role       string          `json:"role"`
	Content    string          `json:"content,omitempty"`
	ToolCalls  []openAIToolCall `json:"tool_calls,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
}

type openAIToolCall struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"`
	Function openAIToolFunction `json:"function"`
}

type openAIToolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type openAIResponse struct {
	Model    string        `json:"model"`
	Choices  []openAIChoice `json:"choices"`
}

type openAIChoice struct {
	Message openAIMessage `json:"message"`
}
