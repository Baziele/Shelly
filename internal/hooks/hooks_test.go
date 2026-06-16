package hooks

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestInjectorAddsBashRcfileArgument(t *testing.T) {
	cmd := exec.Command("/bin/bash")
	inj := &Injector{}
	cleanup, err := inj.Inject(cmd, "bash")
	if err != nil {
		t.Fatalf("Inject failed: %v", err)
	}
	defer cleanup()

	if len(cmd.Args) != 3 || cmd.Args[1] != "--rcfile" {
		t.Fatalf("expected --rcfile argument, got %v", cmd.Args)
	}
	rcfile := cmd.Args[2]
	content, err := os.ReadFile(rcfile)
	if err != nil {
		t.Fatalf("read rcfile: %v", err)
	}
	if !strings.Contains(string(content), "PROMPT_COMMAND") {
		t.Error("rcfile missing PROMPT_COMMAND hook")
	}
	if !strings.Contains(string(content), MarkerPrefix) {
		t.Error("rcfile missing Shelly marker prefix")
	}
	if !strings.Contains(string(content), "__shelly_emit_ac") {
		t.Error("rcfile missing auto-command emitter")
	}
	if !strings.Contains(string(content), "\"_ \"") {
		t.Error("rcfile missing auto-command prefix check")
	}
	if !strings.Contains(string(content), "__shelly_emit_am") {
		t.Error("rcfile missing agent-mode emitter")
	}
	if !strings.Contains(string(content), "\":: \"") {
		t.Error("rcfile missing agent-mode prefix check")
	}
	if !strings.Contains(string(content), "::() { :; }") {
		t.Error("rcfile missing agent-mode no-op function")
	}
}

func envValue(cmd *exec.Cmd, key string) string {
	prefix := key + "="
	for _, e := range cmd.Env {
		if strings.HasPrefix(e, prefix) {
			return e[len(prefix):]
		}
	}
	return ""
}

func TestInjectorSetsZshZdotdir(t *testing.T) {
	cmd := exec.Command("/bin/zsh")
	inj := &Injector{}
	cleanup, err := inj.Inject(cmd, "zsh")
	if err != nil {
		t.Fatalf("Inject failed: %v", err)
	}
	defer cleanup()

	zd := envValue(cmd, "ZDOTDIR")
	if zd == "" {
		t.Fatal("ZDOTDIR not set for zsh")
	}
	content, err := os.ReadFile(filepath.Join(zd, ".zshrc"))
	if err != nil {
		t.Fatalf("read .zshrc: %v", err)
	}
	if !strings.Contains(string(content), "precmd") {
		t.Error(".zshrc missing precmd hook")
	}
	if !strings.Contains(string(content), MarkerPrefix) {
		t.Error(".zshrc missing Shelly marker prefix")
	}
	if !strings.Contains(string(content), "__shelly_emit_ac") {
		t.Error(".zshrc missing auto-command emitter")
	}
	if !strings.Contains(string(content), "\"_ \"") {
		t.Error(".zshrc missing auto-command prefix check")
	}
	if !strings.Contains(string(content), "__shelly_emit_am") {
		t.Error(".zshrc missing agent-mode emitter")
	}
	if !strings.Contains(string(content), "\":: \"") {
		t.Error(".zshrc missing agent-mode prefix check")
	}
	if !strings.Contains(string(content), "function :: { :; }") {
		t.Error(".zshrc missing agent-mode no-op function")
	}
}

func TestInjectorOptOutSkipsInjection(t *testing.T) {
	cmd := exec.Command("/bin/bash")
	inj := &Injector{OptOut: true}
	cleanup, err := inj.Inject(cmd, "bash")
	if err != nil {
		t.Fatalf("Inject failed: %v", err)
	}
	defer cleanup()

	if len(cmd.Args) != 1 {
		t.Errorf("expected no extra args with opt-out, got %v", cmd.Args)
	}
}

func TestInjectorReturnsNoHooksForUnsupportedShell(t *testing.T) {
	cmd := exec.Command("/bin/sh")
	inj := &Injector{}
	cleanup, err := inj.Inject(cmd, "sh")
	if err != nil {
		t.Fatalf("Inject failed: %v", err)
	}
	defer cleanup()

	if len(cmd.Args) != 1 {
		t.Errorf("expected no extra args for unsupported shell, got %v", cmd.Args)
	}
}
