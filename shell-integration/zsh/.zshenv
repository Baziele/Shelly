# Shelly shell integration for zsh, loaded by pointing ZDOTDIR here.
#
# This is the only file zsh reads from here: ZDOTDIR goes straight back to
# the user's own value, then their .zshenv runs, and zsh goes on to read
# .zprofile, .zshrc and .zlogin from their directory exactly as it would
# without Shelly. Hooks are installed at the first prompt, once all of that
# has run. The protocol is described in src/shell/shell-markers.ts.
#
# Everything here runs at the top level (not in a function) so the user's
# files keep their usual scoping, and builtins are quoted so user aliases
# cannot change what they do.

if [[ -n "${SHELLY_USER_ZDOTDIR+x}" ]]; then
  'builtin' 'export' ZDOTDIR="$SHELLY_USER_ZDOTDIR"
else
  'builtin' 'unset' 'ZDOTDIR'
fi
# Kept out of the environment before any of the user's startup commands run.
'builtin' 'typeset' -g __shelly_nonce="${SHELLY_NONCE-}"
'builtin' 'unset' 'SHELLY_USER_ZDOTDIR' 'SHELLY_NONCE'

{
  'builtin' 'typeset' __shelly_file="${ZDOTDIR-$HOME}/.zshenv"
  [[ ! -r "$__shelly_file" ]] || 'builtin' 'source' '--' "$__shelly_file"
} always {
  if [[ -o 'interactive' && -n "$__shelly_nonce" ]]; then
    # This file's directory, whatever ZDOTDIR is now.
    'builtin' 'source' '--' "${${(%):-%x}:A:h}/shelly-hooks.zsh"
  else
    'builtin' 'unset' '__shelly_nonce'
  fi
  'builtin' 'unset' '__shelly_file'
}
