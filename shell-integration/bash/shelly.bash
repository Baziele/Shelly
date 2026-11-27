# Shelly shell integration for bash, loaded with `bash --rcfile`.
#
# Runs the user's ~/.bashrc as bash would have, then installs hooks that
# report each command to Shelly. The protocol is described in
# src/shell/shell-markers.ts. Works with bash 3.2 (macOS) and later.

__shelly_nonce=$SHELLY_NONCE
unset SHELLY_NONCE

# --rcfile replaces ~/.bashrc, so load it ourselves.
if [[ -f "$HOME/.bashrc" ]]; then
  builtin source "$HOME/.bashrc"
fi

if [[ -n "$__shelly_nonce" ]]; then
  __shelly_emit() {
    builtin printf '\033]6973;%s;%s\007' "$__shelly_nonce" "$1"
  }

  # Percent-encode what cannot travel inside an OSC sequence.
  __shelly_encode() {
    local s=${1//'%'/%25}
    s=${s//$'\n'/%0A}
    s=${s//$'\r'/%0D}
    s=${s//$'\033'/%1B}
    s=${s//$'\007'/%07}
    __shelly_encoded=$s
  }

  # The newest history entry. `history` prints "%5d  %s", or "%5d* %s" for
  # an edited entry; strip exactly that so the command keeps its own spacing.
  __shelly_last_history() {
    local entry
    entry=$(HISTTIMEFORMAT= builtin history 1)
    entry=${entry#"${entry%%[![:space:]]*}"}
    __shelly_history_number=${entry%%[!0-9]*}
    entry=${entry#"$__shelly_history_number"}
    if [[ "$entry" == \** ]]; then
      entry=${entry#\* }
    else
      entry=${entry#  }
    fi
    __shelly_history_command=$entry
  }

  __shelly_preexec() {
    local previous=$__shelly_last_history_number
    __shelly_last_history
    __shelly_last_history_number=$__shelly_history_number
    if [[ "$__shelly_history_number" == "$previous" ]]; then
      # Nothing new in history: either a repeat that ignoredups dropped, or a
      # command that ignorespace kept out on purpose. Only the first is safe
      # to report; for the second, report a command without saying what.
      if [[ "$HISTCONTROL" == *ignorespace* || "$HISTCONTROL" == *ignoreboth* ]]; then
        __shelly_emit "exec;"
        return
      fi
    fi
    __shelly_encode "$__shelly_history_command"
    __shelly_emit "exec;$__shelly_encoded"
  }

  __shelly_precmd() {
    local code=$?
    __shelly_emit "done;$code"
    __shelly_encode "$PWD"
    __shelly_emit "cwd;$__shelly_encoded"
    return $code
  }

  # bash has no preexec hook, so use the DEBUG trap: the first command it sees
  # after a prompt is the one the user entered.
  __shelly_debug() {
    [[ "$__shelly_at_prompt" == 1 ]] || return 0
    [[ -z "${COMP_LINE:-}" ]] || return 0
    __shelly_at_prompt=0
    # Pressing Enter on an empty line goes straight to PROMPT_COMMAND.
    [[ "$BASH_COMMAND" == __shelly_* ]] && return 0
    __shelly_preexec
  }

  __shelly_last_history
  __shelly_last_history_number=$__shelly_history_number

  if [[ -n "${bash_preexec_imported:-${__bp_imported:-}}" ]]; then
    # bash-preexec owns the DEBUG trap; join it instead.
    precmd_functions=(__shelly_precmd "${precmd_functions[@]}")
    preexec_functions+=(__shelly_preexec)
  elif [[ -z "$(trap -p DEBUG)" ]]; then
    if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
      PROMPT_COMMAND=(__shelly_precmd "${PROMPT_COMMAND[@]}" "__shelly_at_prompt=1")
    else
      PROMPT_COMMAND="__shelly_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __shelly_at_prompt=1"
    fi
    trap '__shelly_debug' DEBUG
  fi
  # Otherwise something else owns the DEBUG trap and commands go unreported.
fi
