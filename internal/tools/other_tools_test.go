package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecuteShellReturnsOutput(t *testing.T) {
	tool := &ExecuteShell{}
	result, err := tool.Execute(map[string]any{"command": "echo hello"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !strings.Contains(result["stdout"].(string), "hello") {
		t.Errorf("stdout = %q, want hello", result["stdout"])
	}
}

func TestExecuteShellReturnsErrorForMissingCommand(t *testing.T) {
	tool := &ExecuteShell{}
	_, err := tool.Execute(map[string]any{})
	if err == nil {
		t.Fatal("expected error for missing command")
	}
}

func TestEditFileCreatesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "new.txt")

	tool := &EditFile{}
	result, err := tool.Execute(map[string]any{"path": path, "content": "new content"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if result["status"] != "ok" {
		t.Errorf("status = %v", result["status"])
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	if string(data) != "new content" {
		t.Errorf("content = %q, want %q", string(data), "new content")
	}
}

func TestEditFileReturnsErrorForMissingPath(t *testing.T) {
	tool := &EditFile{}
	_, err := tool.Execute(map[string]any{"content": "x"})
	if err == nil {
		t.Fatal("expected error for missing path")
	}
}

func TestSearchOnlineReturnsErrorWhenNotConfigured(t *testing.T) {
	tool := &SearchOnline{}
	result, err := tool.Execute(map[string]any{"query": "golang"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if result["error"] == "" {
		t.Error("expected error when search not configured")
	}
}

func TestSearchOnlineReturnsErrorForMissingQuery(t *testing.T) {
	tool := &SearchOnline{}
	_, err := tool.Execute(map[string]any{})
	if err == nil {
		t.Fatal("expected error for missing query")
	}
}
