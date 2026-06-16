package tools

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"

	"google.golang.org/genai"
)

// SearchOnline searches the web using a configured search API.
type SearchOnline struct{}

func (s *SearchOnline) Name() string        { return "search_online" }
func (s *SearchOnline) Description() string { return "Search the web for information. Returns a summary of results." }

func (s *SearchOnline) Parameters() *genai.Schema {
	return &genai.Schema{
		Type: genai.TypeObject,
		Properties: map[string]*genai.Schema{
			"query": {
				Type:        genai.TypeString,
				Description: "The search query string.",
			},
		},
		Required: []string{"query"},
	}
}

func (s *SearchOnline) Execute(ctx *ToolContext, args map[string]any) (map[string]any, error) {
	query, err := stringParam(args, "query")
	if err != nil {
		return nil, err
	}

	searchURL := os.Getenv("SHELLY_SEARCH_URL")
	if searchURL == "" {
		return map[string]any{
			"error": "online search is not configured. Set SHELLY_SEARCH_URL to a search API endpoint.",
		}, nil
	}

	u, err := url.Parse(searchURL)
	if err != nil {
		return map[string]any{"error": fmt.Sprintf("invalid search URL: %v", err)}, nil
	}
	q := u.Query()
	q.Set("q", query)
	u.RawQuery = q.Encode()

	resp, err := http.Get(u.String())
	if err != nil {
		return map[string]any{"error": err.Error()}, nil
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return map[string]any{"error": err.Error()}, nil
	}

	return map[string]any{
		"results": string(body),
	}, nil
}
