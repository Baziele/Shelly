# Shelly's zsh hooks, sourced from .zshenv in this directory. Each function
# starts with `emulate -L zsh` so the user's options (ksh_arrays, nounset,
# warn_create_global, …) cannot change how it behaves.

'builtin' 'typeset' -g __shelly_encoded=''

__shelly_emit() {
  'builtin' 'emulate' -L zsh
  'builtin' 'printf' '\e]6973;%s;%s\a' "$__shelly_nonce" "$1"
}

# Percent-encode what cannot travel inside an OSC sequence, and keep long
# command lines (a pasted script, say) to a sensible size.
__shelly_encode() {
  'builtin' 'emulate' -L zsh
  local text=${1[1,8192]}
  text=${text//'%'/%25}
  text=${text//$'\n'/%0A}
  text=${text//$'\r'/%0D}
  text=${text//$'\e'/%1B}
  text=${text//$'\a'/%07}
  __shelly_encoded=$text
}

__shelly_preexec() {
  'builtin' 'emulate' -L zsh
  # $1 is the line as typed; it is empty when history is off, so fall back
  # to the expanded text.
  __shelly_encode "${1:-$3}"
  __shelly_emit "exec;$__shelly_encoded"
}

__shelly_precmd() {
  local code=$?
  'builtin' 'emulate' -L zsh
  __shelly_emit "done;$code"
  __shelly_encode "$PWD"
  __shelly_emit "cwd;$__shelly_encoded"
  return $code
}

# Runs once, at the first prompt, after every startup file: put Shelly's
# precmd first (so $? is still the command's status) and its preexec last.
__shelly_install() {
  'builtin' 'emulate' -L zsh
  (( ${+functions[__shelly_install]} )) || return 0
  precmd_functions=(__shelly_precmd ${precmd_functions:#(__shelly_install|__shelly_precmd)})
  preexec_functions=(${preexec_functions:#__shelly_preexec} __shelly_preexec)
  'builtin' 'unfunction' __shelly_install
  __shelly_precmd
}

# Two ways to reach the first prompt, in case a .zshrc replaces
# precmd_functions wholesale: whichever runs first installs the hooks.
'builtin' 'typeset' -ga precmd_functions
precmd_functions+=(__shelly_install)
if 'builtin' 'zmodload' zsh/sched 2>/dev/null; then
  'builtin' 'sched' +0 '(( ${+functions[__shelly_install]} )) && __shelly_install'
fi
