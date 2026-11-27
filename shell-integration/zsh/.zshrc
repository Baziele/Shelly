# Shelly shell integration: see .zshenv in this directory.
__shelly_source_user .zshrc
__shelly_restore_zdotdir

# System startup files read before this one saw ZDOTDIR pointing here; macOS's
# /etc/zshrc, for one, sets HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history.
if [[ "$HISTFILE" == "$__shelly_dir"/* ]]; then
  HISTFILE="$__shelly_zdotdir/${HISTFILE#"$__shelly_dir"/}"
fi
unfunction __shelly_source_user __shelly_restore_zdotdir
unset __shelly_zdotdir __shelly_had_zdotdir

if [[ -n "$__shelly_nonce" ]]; then
  __shelly_emit() {
    builtin printf '\e]6973;%s;%s\a' "$__shelly_nonce" "$1"
  }

  # Percent-encode what cannot travel inside an OSC sequence.
  __shelly_encode() {
    __shelly_encoded=${1//'%'/%25}
    __shelly_encoded=${__shelly_encoded//$'\n'/%0A}
    __shelly_encoded=${__shelly_encoded//$'\r'/%0D}
    __shelly_encoded=${__shelly_encoded//$'\e'/%1B}
    __shelly_encoded=${__shelly_encoded//$'\a'/%07}
  }

  __shelly_preexec() {
    # $1 is the line as typed; it is empty when history is off, so fall back
    # to the expanded text.
    __shelly_encode "${1:-$3}"
    __shelly_emit "exec;$__shelly_encoded"
  }

  __shelly_precmd() {
    local code=$?
    __shelly_emit "done;$code"
    __shelly_encode "$PWD"
    __shelly_emit "cwd;$__shelly_encoded"
    return $code
  }

  # First in line, so $? is still the command's exit status.
  precmd_functions=(__shelly_precmd $precmd_functions)
  preexec_functions+=(__shelly_preexec)
fi
