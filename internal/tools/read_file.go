package tools

import (
	"os"

	"google.golang.org/genai"
)

// ReadFile reads a file from the local filesystem.
type ReadFile struct{}

func (r *ReadFile) Name() string        { return "read_file" }
func (r *ReadFile) Description() string { return "Read the contents of a file at the given path." }

func (r *ReadFile) Parameters() *genai.Schema {
	return &genai.Schema{
		Type: genai.TypeObject,
		Properties: map[string]*genai.Schema{
			"path": {
				Type:        genai.TypeString,
				Description: "The absolute or relative path to the file to read.",
			},
		},
		Required: []string{"path"},
	}
}

func (r *ReadFile) Execute(ctx *ToolContext, args map[string]any) (map[string]any, error) {
	path, err := stringParam(args, "path")
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(resolvePath(ctx, path))
	if err != nil {
		return map[string]any{"error": err.Error()}, nil
	}
	return map[string]any{"content": string(data)}, nil
}
