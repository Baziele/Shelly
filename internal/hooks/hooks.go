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

__shelly_emit_qr() {
    local question="$1"
    local b64
    b64=$(printf '%s' "$question" | base64 | tr -d '\n')
    printf '\033]777;shelly;qr=%s\007' "$b64" >&2
}

__shelly_emit_ac() {
    local request="$1"
    local b64
    b64=$(printf '%s' "$request" | base64 | tr -d '\n')
    printf '\033]777;shelly;ac=%s\007' "$b64" >&2
}

__shelly_emit_am() {
    local message="$1"
    local b64
    b64=$(printf '%s' "$message" | base64 | tr -d '\n')
    printf '\033]777;shelly;am=%s\007' "$b64" >&2
}

_() { :; }
::() { :; }

__shelly_prompt_command() {
    local code=$?
    local last
    last=$(history 1 2>/dev/null | sed 's/^[[:space:]]*[0-9]*[[:space:]]*//')
    if [ -n "$last" ]; then
        __shelly_emit "$last" "$code"
    fi
}

__shelly_debug_trap() {
    if [[ "$BASH_COMMAND" == ": "* ]]; then
        __shelly_emit_qr "${BASH_COMMAND#: }"
        history -s "$BASH_COMMAND"
        return 1
    fi
    if [[ "$BASH_COMMAND" == "_ "* ]]; then
        __shelly_emit_ac "${BASH_COMMAND#_ }"
        history -s "$BASH_COMMAND"
        return 1
    fi
    if [[ "$BASH_COMMAND" == ":: "* ]]; then
        __shelly_emit_am "${BASH_COMMAND#:: }"
        history -s "$BASH_COMMAND"
        return 1
    fi
}

PROMPT_COMMAND="__shelly_prompt_command${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
trap '__shelly_debug_trap' DEBUG
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

__shelly_emit_qr() {
    local question="$1"
    local b64
    b64=$(printf '%s' "$question" | base64 | tr -d '\n')
    printf '\033]777;shelly;qr=%s\007' "$b64" >&2
}

__shelly_emit_am() {
    local message="$1"
    local b64
    b64=$(printf '%s' "$message" | base64 | tr -d '\n')
    printf '\033]777;shelly;am=%s\007' "$b64" >&2
}

function _ { :; }
function :: { :; }

__shelly_precmd() {
    local code=$?
    local last
    last=$(fc -ln -1 2>/dev/null | sed 's/^[[:space:]]*//')
    if [ -n "$last" ]; then
        __shelly_emit "$last" "$code"
    fi
}

__shelly_accept_line() {
    if [[ "$BUFFER" == ": "* ]]; then
        __shelly_emit_qr "${BUFFER#: }"
        print -s "$BUFFER"
        BUFFER=""
    fi
    if [[ "$BUFFER" == "_ "* ]]; then
        __shelly_emit_ac "${BUFFER#_ }"
        print -s "$BUFFER"
        BUFFER=""
    fi
    if [[ "$BUFFER" == ":: "* ]]; then
        __shelly_emit_am "${BUFFER#:: }"
        print -s "$BUFFER"
        BUFFER=""
    fi
    zle .accept-line
}

zle -N accept-line __shelly_accept_line
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
