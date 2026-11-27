# Shelly's zsh hooks, sourced from .zshenv in this directory. Each function
# starts with `emulate -L zsh` so the user's options (ksh_arrays, nounset,
# warn_create_global, …) cannot change how it behaves.

'builtin' 'typeset' -g __shelly_encoded=''

__shelly_emit() {
  'builtin' 'emulate' -L zsh
  'builtin' 'printf' '\e]6973;%s;%s\a' "$__shelly_nonce" "$1"
}

# Percent-encode what cannot travel inside an OSC sequence, and keep long
# command lines (a pasted script, say) to a sensible size: $2 characters,
# 8192 by default.
__shelly_encode() {
  'builtin' 'emulate' -L zsh
  local text=${1[1,${2:-8192}]}
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

# The input line. Shelly reads and sets it by sending keys no terminal sends
# (F12 and F11 with every modifier held; see src/shell/line-editor.ts).

# Report the line and the cursor (in characters), then clear the line so
# Shelly can draw there. A line too long to report is left as it is.
__shelly_line_capture() {
  'builtin' 'emulate' -L zsh
  __shelly_encode "$BUFFER" ${#BUFFER}
  if (( ${#__shelly_encoded} > 60000 )); then
    __shelly_emit 'line;;-1'
    return 0
  fi
  local cursor=$CURSOR
  BUFFER=''
  # Redraw before reporting, so the cleared line is on screen by the time
  # Shelly hears about it.
  'builtin' 'zle' -R
  __shelly_emit "line;$__shelly_encoded;$cursor"
}

# Replace the line with the file Shelly wrote: the cursor (in characters) on
# the first line, the text after it. The file is removed once read.
__shelly_line_set() {
  'builtin' 'emulate' -L zsh
  local file=$__shelly_line_file cursor='' text=''
  [[ -n $file && -f $file && ! -L $file ]] || return 0
  {
    IFS= 'builtin' 'read' -r cursor
    # Up to a NUL, which never comes: everything else, newlines included.
    IFS= 'builtin' 'read' -r -d '' text
  } < $file
  'builtin' 'zf_rm' -f -- $file 2>/dev/null || 'command' 'rm' -f -- $file
  BUFFER=$text
  if [[ $cursor == <-> ]] && (( cursor < ${#BUFFER} )); then
    CURSOR=$cursor
  else
    CURSOR=${#BUFFER}
  fi
  __shelly_emit 'line-set;'
}

# Bound in every keymap a user might be in, then announced to Shelly.
__shelly_bind_line_keys() {
  'builtin' 'emulate' -L zsh
  [[ -o zle ]] || return 0
  'builtin' 'zmodload' -F zsh/files b:zf_rm 2>/dev/null
  'builtin' 'zle' -N __shelly_line_capture || return 0
  'builtin' 'zle' -N __shelly_line_set || return 0
  local keymap
  for keymap in main emacs viins vicmd; do
    'builtin' 'bindkey' -M $keymap '^[[24;16~' __shelly_line_capture 2>/dev/null || return 0
    'builtin' 'bindkey' -M $keymap '^[[23;16~' __shelly_line_set 2>/dev/null || return 0
  done
  __shelly_emit 'line-editor;capture,set'
}

# Runs once, at the first prompt, after every startup file: put Shelly's
# precmd first (so $? is still the command's status) and its preexec last,
# and bind its keys over whatever keymaps the startup files chose.
__shelly_install() {
  'builtin' 'emulate' -L zsh
  (( ${+functions[__shelly_install]} )) || return 0
  precmd_functions=(__shelly_precmd ${precmd_functions:#(__shelly_install|__shelly_precmd)})
  preexec_functions=(${preexec_functions:#__shelly_preexec} __shelly_preexec)
  'builtin' 'unfunction' __shelly_install
  __shelly_bind_line_keys
  __shelly_precmd
}

# Two ways to reach the first prompt, in case a .zshrc replaces
# precmd_functions wholesale: whichever runs first installs the hooks.
'builtin' 'typeset' -ga precmd_functions
precmd_functions+=(__shelly_install)
if 'builtin' 'zmodload' zsh/sched 2>/dev/null; then
  'builtin' 'sched' +0 '(( ${+functions[__shelly_install]} )) && __shelly_install'
fi
