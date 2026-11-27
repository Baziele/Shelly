# Shelly shell integration for fish, loaded with `fish --init-command`, which
# runs after the user's own config. The same init command sets
# __shelly_nonce, so it never sits in the environment of anything config.fish
# starts. Reports each command to Shelly; the protocol is described in
# src/shell/shell-markers.ts.

if test -n "$__shelly_nonce"
    function __shelly_emit
        printf '\e]6973;%s;%s\a' $__shelly_nonce $argv[1]
    end

    function __shelly_preexec --on-event fish_preexec
        # Long command lines (a pasted script, say) are kept to a sensible size.
        set -l command (string sub --length 8192 -- $argv[1] | string collect)
        set -l encoded (string escape --style=url -- "$command")
        __shelly_emit "exec;$encoded"
    end

    function __shelly_postexec --on-event fish_postexec
        __shelly_emit "done;$status"
    end

    function __shelly_prompt --on-event fish_prompt
        set -l cwd (string escape --style=url -- $PWD)
        __shelly_emit "cwd;$cwd"
    end
end
