# Shelly shell integration for bash, loaded with `bash --rcfile`.
#
# Runs the user's ~/.bashrc as bash would have, then installs hooks that
# report each command to Shelly. The protocol is described in
# src/shell/shell-markers.ts. Works with bash 3.2 (macOS) and later.
#
# The command line comes from history, so a command bash keeps out of
# history (a leading space with ignorespace, HISTIGNORE) is reported without
# a name, and Shelly does not record it.

__shelly_nonce=${SHELLY_NONCE-}
__shelly_line_file=${SHELLY_LINE_FILE-}
unset SHELLY_NONCE SHELLY_LINE_FILE

# --rcfile replaces ~/.bashrc, so load it ourselves.
if [[ -f "$HOME/.bashrc" ]]; then
  builtin source "$HOME/.bashrc"
fi

if [[ -n "$__shelly_nonce" ]]; then
  __shelly_emit() {
    builtin printf '\033]6973;%s;%s\007' "$__shelly_nonce" "$1"
  }

  # Percent-encode what cannot travel inside an OSC sequence, and keep long
  # command lines (a pasted script, say) to a sensible size: $2 characters,
  # 8192 by default.
  __shelly_encode() {
    local s=${1:0:${2:-8192}}
    s=${s//'%'/%25}
    s=${s//$'\n'/%0A}
    s=${s//$'\r'/%0D}
    s=${s//$'\033'/%1B}
    s=${s//$'\007'/%07}
    __shelly_encoded=$s
  }

  # The newest history entry. `history` prints "%5d  %s", or "%5d* %s" for
  # an edited entry; strip exactly that so the command keeps its own spacing.
  __shelly_read_history() {
    local entry
    entry=$(HISTTIMEFORMAT='' builtin history 1)
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

  __shelly_precmd() {
    local code=$?
    __shelly_emit "done;$code"
    __shelly_encode "$PWD"
    __shelly_emit "cwd;$__shelly_encoded"
    return $code
  }

  __shelly_encoded=''
  __shelly_history_number=''
  __shelly_history_command=''
  __shelly_prompt_history=''
  __shelly_at_prompt=0

  # PS0 needs prompt expansion (promptvars), or it would print itself.
  if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )) \
    && [[ -z "${bash_preexec_imported:-${__bp_imported:-}}" ]] && shopt -q promptvars; then
    # bash 4.4+: PS0 is expanded right before a command line runs. HISTCMD
    # there is one past the number seen at the prompt only if the line was
    # added to history; otherwise it was kept out, and stays unnamed.
    __shelly_ps0() {
      if [[ "$HISTCMD" == "$__shelly_prompt_history" ]]; then
        __shelly_emit "exec;"
      else
        __shelly_read_history
        __shelly_encode "$__shelly_history_command"
        __shelly_emit "exec;$__shelly_encoded"
      fi
    }
    # Last in PROMPT_COMMAND, after anything that reloads history.
    __shelly_prompt_ready() {
      local code=$?
      __shelly_prompt_history=$HISTCMD
      return $code
    }
    PS0='$(__shelly_ps0)'"${PS0-}"
  else
    # bash 3.2 (or promptvars off), or bash-preexec owns the DEBUG trap: the
    # first command the trap sees after a prompt is the one the user entered.
    __shelly_preexec() {
      local previous=$__shelly_prompt_history
      __shelly_read_history
      # Not added to history: a repeat that ignoredups dropped can be named
      # when it is exactly the last entry; anything else was kept out on
      # purpose. (BASH_COMMAND is only the first simple command, so a
      # repeated pipeline goes unnamed.)
      if [[ "$__shelly_history_number" == "$previous" && "$__shelly_history_command" != "$BASH_COMMAND" ]]; then
        __shelly_emit "exec;"
        return
      fi
      __shelly_encode "$__shelly_history_command"
      __shelly_emit "exec;$__shelly_encoded"
    }
    __shelly_debug() {
      [[ "$__shelly_at_prompt" == 1 ]] || return 0
      # Completion functions and `bind -x` widgets (fzf, atuin) run at the
      # prompt; they are not the command being entered.
      [[ -z "${COMP_LINE-}" && -z "${READLINE_LINE+x}" ]] || return 0
      __shelly_at_prompt=0
      # Pressing Enter on an empty line goes straight to PROMPT_COMMAND.
      [[ "$BASH_COMMAND" == __shelly_* ]] && return 0
      __shelly_preexec
    }
    __shelly_prompt_ready() {
      local code=$?
      __shelly_read_history
      __shelly_prompt_history=$__shelly_history_number
      __shelly_at_prompt=1
      return $code
    }
  fi

  if [[ -n "${bash_preexec_imported:-${__bp_imported:-}}" ]]; then
    precmd_functions=(__shelly_precmd ${precmd_functions[@]+"${precmd_functions[@]}"} __shelly_prompt_ready)
    preexec_functions+=(__shelly_preexec)
    # bash-preexec calls preexec itself; the at-prompt guard is not needed.
    __shelly_at_prompt=1
  elif [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__shelly_precmd ${PROMPT_COMMAND[@]+"${PROMPT_COMMAND[@]}"} __shelly_prompt_ready)
  else
    # Joined with newlines: a user value may end in `;`, `&` or a comment.
    PROMPT_COMMAND=$'__shelly_precmd\n'"${PROMPT_COMMAND-}"$'\n__shelly_prompt_ready'
  fi

  if declare -F __shelly_debug >/dev/null && [[ -z "${bash_preexec_imported:-${__bp_imported:-}}" ]]; then
    if [[ -z "$(trap -p DEBUG)" ]]; then
      trap '__shelly_debug' DEBUG
    fi
    # Otherwise something else owns the DEBUG trap and commands go unreported.
  fi

  # The input line. Shelly reads and sets it by sending keys no terminal sends
  # (function keys with every modifier held; see src/shell/line-editor.ts).
  if (( BASH_VERSINFO[0] >= 4 )); then
    # bash 4.0 to 5.0 count READLINE_POINT in bytes, later ones in characters.
    if (( BASH_VERSINFO[0] == 4 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] == 0) )); then
      __shelly_point_in_bytes=1
    else
      __shelly_point_in_bytes=0
    fi
    __shelly_prefix=''
    __shelly_length=0

    # The first $2 bytes of $1.
    __shelly_byte_prefix() {
      local LC_ALL=C
      __shelly_prefix=${1:0:$2}
    }

    # The length of $1 in bytes.
    __shelly_byte_length() {
      local LC_ALL=C
      __shelly_length=${#1}
    }

    # Report the line and the cursor (in characters), then clear the line so
    # Shelly can draw there. A line too long to report is left as it is.
    __shelly_line_capture() {
      local line=$READLINE_LINE point=$READLINE_POINT
      __shelly_encode "$line" "${#line}"
      if (( ${#__shelly_encoded} > 60000 )); then
        __shelly_emit 'line;;-1'
        return 0
      fi
      if [[ "$__shelly_point_in_bytes" == 1 ]]; then
        __shelly_byte_prefix "$line" "$point"
        point=${#__shelly_prefix}
      fi
      READLINE_LINE=''
      READLINE_POINT=0
      __shelly_emit "line;$__shelly_encoded;$point"
    }

    # Replace the line with the file Shelly wrote: the cursor (in
    # characters) on the first line, the text after it. The file is removed
    # once read.
    __shelly_line_set() {
      local file=${__shelly_line_file-} cursor='' text=''
      [[ -n "$file" && -f "$file" && ! -L "$file" ]] || return 0
      {
        IFS= builtin read -r cursor || builtin true
        # Up to a NUL, which never comes: everything else, newlines included.
        IFS= builtin read -r -d '' text || builtin true
      } < "$file"
      command rm -f -- "$file"
      if [[ -z "$cursor" || "$cursor" == *[!0-9]* ]] || (( cursor > ${#text} )); then
        cursor=${#text}
      fi
      if [[ "$__shelly_point_in_bytes" == 1 ]]; then
        __shelly_byte_length "${text:0:cursor}"
        cursor=$__shelly_length
      fi
      READLINE_LINE=$text
      READLINE_POINT=$cursor
      __shelly_emit 'line-set;'
    }

    __shelly_line_features='capture,set'
    for __shelly_keymap in emacs vi-insert vi-command; do
      builtin bind -m "$__shelly_keymap" -x '"\e[24;16~": __shelly_line_capture' 2>/dev/null \
        && builtin bind -m "$__shelly_keymap" -x '"\e[23;16~": __shelly_line_set' 2>/dev/null \
        || __shelly_line_features=''
    done
  else
    # bash 3.2 has bind -x but no READLINE_LINE, so the line cannot be read
    # or set. It gets a key that clears the line (Shelly then types the new
    # one; from vi-command mode it enters insert mode first) and one that
    # redraws the prompt and line where the cursor is.
    __shelly_line_features='clear,redraw'
    for __shelly_keymap in emacs vi-insert vi-command; do
      if [[ "$__shelly_keymap" == vi-command ]]; then
        builtin bind -m vi-command '"\e[21;16~": "i\e[21;16~"' 2>/dev/null || __shelly_line_features=''
      else
        builtin bind -m "$__shelly_keymap" '"\e[21;16~": kill-whole-line' 2>/dev/null || __shelly_line_features=''
      fi
      builtin bind -m "$__shelly_keymap" '"\e[20;16~": redraw-current-line' 2>/dev/null || __shelly_line_features=''
    done
  fi
  unset __shelly_keymap
  # Without line editing (bash --noediting) there is nothing to announce.
  if [[ -n "$__shelly_line_features" ]]; then
    __shelly_emit "line-editor;$__shelly_line_features"
  fi
  unset __shelly_line_features
fi
