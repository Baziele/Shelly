package tools

import (
	"os"

	"google.golang.org/genai"
)

// EditFile creates, overwrites, or modifies a file.
type EditFile struct{}

func (e *EditFile) Name() string        { return "edit_file" }
func (e *EditFile) Description() string { return "Write content to a file. Creates the file if it does not exist, overwrites if it does." }

func (e *EditFile) Parameters() *genai.Schema {
	return &genai.Schema{
		Type: genai.TypeObject,
		Properties: map[string]*genai.Schema{
			"path": {
				Type:        genai.TypeString,
				Description: "The absolute or relative path to the file.",
			},
			"content": {
				Type:        genai.TypeString,
				Description: "The full content to write to the file.",
			},
		},
		Required: []string{"path", "content"},
	}
}

func (e *EditFile) Execute(ctx *ToolContext, args map[string]any) (map[string]any, error) {
	path, err := stringParam(args, "path")
	if err != nil {
		return nil, err
	}
	content, err := stringParam(args, "content")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(resolvePath(ctx, path), []byte(content), 0o644); err != nil {
		return map[string]any{"error": err.Error()}, nil
	}
	return map[string]any{"status": "ok"}, nil
}
