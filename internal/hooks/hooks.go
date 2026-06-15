// Package hooks auto-injects shell integration hooks that emit invisible
// markers Shelly can parse to build Command History.
package hooks

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// Injector prepares a shell command with hooks for supported shells.
type Injector struct {
	// OptOut disables auto-injection when true.
	OptOut bool
}

// Inject modifies cmd so the spawned shell runs Shelly hooks. It returns a
// cleanup function that should be called after the shell exits to remove any
// temporary files created for the hooks.
func (i *Injector) Inject(cmd *exec.Cmd, shell string) (func(), error) {
	if i.OptOut {
		return func() {}, nil
	}

	switch shell {
	case "bash":
		return i.injectBash(cmd)
	case "zsh":
		return i.injectZsh(cmd)
	default:
		// Unsupported shells degrade gracefully to prompt-pattern detection.
		return func() {}, nil
	}
}

func (i *Injector) injectBash(cmd *exec.Cmd) (func(), error) {
	rcfile, err := os.CreateTemp("", "shelly-bashrc-*.sh")
	if err != nil {
		return nil, fmt.Errorf("create bash rcfile: %w", err)
	}
	defer rcfile.Close()

	if _, err := rcfile.WriteString(bashHookScript()); err != nil {
		os.Remove(rcfile.Name())
		return nil, fmt.Errorf("write bash rcfile: %w", err)
	}

	cmd.Args = append([]string{cmd.Args[0], "--rcfile", rcfile.Name()}, cmd.Args[1:]...)

	return func() { _ = os.Remove(rcfile.Name()) }, nil
}

func (i *Injector) injectZsh(cmd *exec.Cmd) (func(), error) {
	dir, err := os.MkdirTemp("", "shelly-zdotdir-*")
	if err != nil {
		return nil, fmt.Errorf("create zsh zdotdir: %w", err)
	}

	writeFile := func(name, content string) error {
		path := filepath.Join(dir, name)
		return os.WriteFile(path, []byte(content), 0o644)
	}

	if err := writeFile(".zshenv", zshEnvScript()); err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("write zsh .zshenv: %w", err)
	}
	if err := writeFile(".zshrc", zshRcScript()); err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("write zsh .zshrc: %w", err)
	}

	cmd.Env = appendOrSetEnv(cmd.Env, "ZDOTDIR", dir)

	return func() { _ = os.RemoveAll(dir) }, nil
}

func bashHookScript() string {
	return `# Shelly command-boundary hooks for bash.
if [ -f "$HOME/.bashrc" ]; then
    source "$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
    source "$HOME/.bash_profile"
fi

__shelly_emit() {
    local cmd="$1"
    local code="$2"
    local b64
    b64=$(printf '%s' "$cmd" | base64 | tr -d '\n')
    printf '\033]777;shelly;cmd=%s;exit=%s\007' "$b64" "$code" >&2
}

__shelly_prompt_command() {
    local code=$?
    local last
    last=$(history 1 2>/dev/null | sed 's/^[[:space:]]*[0-9]*[[:space:]]*//')
    if [ -n "$last" ]; then
        __shelly_emit "$last" "$code"
    fi
}

PROMPT_COMMAND="__shelly_prompt_command${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
`
}

func zshEnvScript() string {
	return `# Shelly zsh environment hook.
if [ -f "$HOME/.zshenv" ]; then
    source "$HOME/.zshenv"
fi
`
}

func zshRcScript() string {
	return `# Shelly command-boundary hooks for zsh.
if [ -f "$HOME/.zshrc" ]; then
    source "$HOME/.zshrc"
fi

__shelly_emit() {
    local cmd="$1"
    local code="$2"
    local b64
    b64=$(printf '%s' "$cmd" | base64 | tr -d '\n')
    printf '\033]777;shelly;cmd=%s;exit=%s\007' "$b64" "$code" >&2
}

__shelly_precmd() {
    local code=$?
    local last
    last=$(fc -ln -1 2>/dev/null | sed 's/^[[:space:]]*//')
    if [ -n "$last" ]; then
        __shelly_emit "$last" "$code"
    fi
}

precmd_functions+=(__shelly_precmd)
`
}

func appendOrSetEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, e := range env {
		if len(e) >= len(prefix) && e[:len(prefix)] == prefix {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}
