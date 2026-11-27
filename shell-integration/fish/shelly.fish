# Shelly shell integration for fish, loaded with `fish --init-command`, which
# runs after the user's own config. Reports each command to Shelly; the
# protocol is described in src/shell/shell-markers.ts.

set -g __shelly_nonce $SHELLY_NONCE
set -e SHELLY_NONCE

if test -n "$__shelly_nonce"
    function __shelly_emit
        printf '\e]6973;%s;%s\a' $__shelly_nonce $argv[1]
    end

    function __shelly_preexec --on-event fish_preexec
        set -l command (string escape --style=url -- $argv[1])
        __shelly_emit "exec;$command"
    end

    function __shelly_postexec --on-event fish_postexec
        __shelly_emit "done;$status"
    end

    function __shelly_prompt --on-event fish_prompt
        set -l cwd (string escape --style=url -- $PWD)
        __shelly_emit "cwd;$cwd"
    end
end
