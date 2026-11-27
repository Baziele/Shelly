# Shelly shell integration for zsh, loaded by pointing ZDOTDIR here.
#
# Each of these startup files runs the user's own copy from their real
# ZDOTDIR, so the shell is configured exactly as it would be without Shelly.
# .zshrc then hands ZDOTDIR back and installs hooks that report each command
# to Shelly. The protocol is described in src/shell/shell-markers.ts.

typeset -g __shelly_dir="$ZDOTDIR"
typeset -g __shelly_zdotdir="${SHELLY_USER_ZDOTDIR:-$HOME}"
typeset -g __shelly_had_zdotdir="${SHELLY_USER_ZDOTDIR+1}"
typeset -g __shelly_nonce="$SHELLY_NONCE"
unset SHELLY_USER_ZDOTDIR SHELLY_NONCE

# Terminal.app keeps per-session history keyed by TERM_SESSION_ID, which this
# shell inherits from the one Shelly was started in. Let that shell own it.
[[ -z "${SHELL_SESSIONS_DISABLE+x}" ]] && SHELL_SESSIONS_DISABLE=1

__shelly_source_user() {
  [[ -f "$__shelly_zdotdir/$1" ]] || return 0
  ZDOTDIR="$__shelly_zdotdir"
  builtin source "$__shelly_zdotdir/$1"
  # A user's .zshenv may move ZDOTDIR (to ~/.config/zsh, say); follow it.
  if [[ "$ZDOTDIR" != "$__shelly_zdotdir" ]]; then
    __shelly_zdotdir="$ZDOTDIR"
    __shelly_had_zdotdir=1
  fi
  ZDOTDIR="$__shelly_dir"
}

__shelly_restore_zdotdir() {
  if [[ -n "$__shelly_had_zdotdir" ]]; then
    ZDOTDIR="$__shelly_zdotdir"
  else
    unset ZDOTDIR
  fi
}

__shelly_source_user .zshenv

# Only interactive shells read .zshrc, where ZDOTDIR is normally restored.
[[ -o interactive ]] || __shelly_restore_zdotdir
