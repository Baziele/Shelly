package tools

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadFileReturnsContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(path, []byte("hello world"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	tool := &ReadFile{}
	result, err := tool.Execute(&ToolContext{}, map[string]any{"path": path})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if result["content"] != "hello world" {
		t.Errorf("content = %q, want %q", result["content"], "hello world")
	}
}

func TestReadFileReturnsErrorForMissingPath(t *testing.T) {
	tool := &ReadFile{}
	_, err := tool.Execute(&ToolContext{}, map[string]any{})
	if err == nil {
		t.Fatal("expected error for missing path")
	}
}

func TestReadFileReturnsErrorResultForMissingFile(t *testing.T) {
	tool := &ReadFile{}
	result, err := tool.Execute(&ToolContext{}, map[string]any{"path": "/nonexistent/path"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if result["error"] == "" {
		t.Error("expected error key for missing file")
	}
}

func TestRegistryContainsReadFile(t *testing.T) {
	r := NewRegistry()
	if _, ok := r.Get("read_file"); !ok {
		t.Error("registry missing read_file")
	}
}

func TestRegistryGenaiTools(t *testing.T) {
	r := NewRegistry()
	tools := r.GenaiTools()
	if len(tools) != 1 {
		t.Fatalf("expected 1 genai.Tool, got %d", len(tools))
	}
	decls := tools[0].FunctionDeclarations
	if len(decls) != 4 {
		t.Fatalf("expected 4 declarations, got %d", len(decls))
	}
	found := false
	for _, d := range decls {
		if d.Name == "read_file" {
			found = true
			break
		}
	}
	if !found {
		t.Error("genai tools missing read_file")
	}
}

func TestRegistryRun(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(path, []byte("registry test"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	r := NewRegistry()
	result, err := r.Run(&ToolContext{}, "read_file", map[string]any{"path": path})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result["content"] != "registry test" {
		t.Errorf("content = %q, want %q", result["content"], "registry test")
	}
}

func TestRegistryRunUnknownTool(t *testing.T) {
	r := NewRegistry()
	_, err := r.Run(&ToolContext{}, "nonexistent", map[string]any{})
	if err == nil {
		t.Fatal("expected error for unknown tool")
	}
}
