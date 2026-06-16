package llm

import (
	"context"
	"os"
	"testing"

	"google.golang.org/adk/model"
	"google.golang.org/genai"
)

func TestRealAPI(t *testing.T) {
	if os.Getenv("TEST_REAL_API") == "" {
		t.Skip("TEST_REAL_API not set")
	}

	adapter := NewOpenAIAdapter()

	req := &model.LLMRequest{
		Model: "deepseek-v4-flash",
		Contents: []*genai.Content{
			genai.NewContentFromText("Say hello in exactly one word", genai.RoleUser),
		},
	}

	var resp *model.LLMResponse
	var err error
	for r, e := range adapter.GenerateContent(context.Background(), req, false) {
		resp = r
		err = e
	}

	if err != nil {
		t.Fatalf("API error: %v", err)
	}
	if resp == nil {
		t.Fatal("resp is nil")
	}
	if resp.Content == nil {
		t.Fatal("Content is nil")
	}
	if len(resp.Content.Parts) == 0 {
		t.Fatal("no parts in response")
	}
	if resp.Content.Parts[0].Text == "" {
		t.Fatal("empty text response")
	}

	t.Logf("Response: %s", resp.Content.Parts[0].Text)
}
