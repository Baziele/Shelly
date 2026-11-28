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
        # Long command lines (a pasted script, say) are kept to a sensible
        # size; URL encoding can make each character up to 12 long.
        set -l command (string sub --length 4096 -- $argv[1] | string collect)
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

    # The input line. Shelly reads and sets it by sending keys no terminal
    # sends (F12 and F11 with every modifier held; see src/shell/line-editor.ts).

    # Report the line and the cursor (in characters), then clear the line so
    # Shelly can draw there. A line too long to report is left as it is. The
    # answer names the request Shelly left in the line file (`capture <n>`);
    # none there means Shelly has given up on it.
    function __shelly_line_capture
        set -l request ''
        set -l file $__shelly_line_file
        if test -n "$file" -a -f "$file" -a ! -L "$file"
            set -l header
            read header < $file
            # Anything else is not a capture request: leave it for its own key.
            if string match -qr -- '^capture [0-9]+$' "$header"
                set request (string replace -- 'capture ' '' "$header")
                command rm -f -- $file
            end
        end
        # `commandline` prints the line and a newline; the newline is dropped
        # again once encoded.
        set -l line (commandline | string collect -N)
        set -l encoded (string escape --style=url -- "$line")
        set encoded (string replace -r -- '%0A$' '' "$encoded")
        if test (string length -- "$encoded") -gt 60000
            __shelly_emit "line;$request;;-1"
            return
        end
        set -l cursor (commandline -C)
        commandline -r ''
        commandline -f repaint
        __shelly_emit "line;$request;$encoded;$cursor"
    end

    # Report the line and the cursor (in characters), leaving both as they
    # are, to the request Shelly left in the line file (`query <n>`). With
    # none there, Shelly has stopped waiting, so nothing is reported.
    function __shelly_line_query
        set -l file $__shelly_line_file
        test -n "$file" -a -f "$file" -a ! -L "$file"; or return
        set -l header
        read header < $file
        # Any other request belongs to another key.
        string match -qr -- '^query [0-9]+$' "$header"; or return
        # Shelly withdraws the request once answered: no rm, which would
        # cost a process on a keystroke Shelly is holding.
        set -l request (string replace -- 'query ' '' "$header")
        set -l line (commandline | string collect -N)
        set -l encoded (string escape --style=url -- "$line")
        set encoded (string replace -r -- '%0A$' '' "$encoded")
        if test (string length -- "$encoded") -gt 60000
            __shelly_emit "query;$request;;-1"
            return
        end
        __shelly_emit "query;$request;$encoded;"(commandline -C)
    end

    # Replace the line with the file Shelly wrote: `set <request> <cursor>`
    # (the cursor in characters) on the first line, the text after it. The
    # file is removed once read.
    function __shelly_line_set
        set -l file $__shelly_line_file
        test -n "$file" -a -f "$file" -a ! -L "$file"; or return
        set -l header
        set -l text
        # An empty IFS: `read` neither splits nor trims, whatever the user's
        # IFS, so leading and trailing whitespace stays on the line.
        set -l IFS
        begin
            read header
            # Up to a NUL, which never comes: everything else, newlines included.
            read -z text
        end < $file
        # A capture request belongs to the other key.
        string match -qr -- '^set [0-9]+ [0-9]+$' "$header"; or return
        set -l fields (string split -- ' ' "$header")
        set -l request $fields[2]
        set -l cursor $fields[3]
        command rm -f -- $file
        set -l length (string length -- "$text")
        commandline -r -- "$text"
        if test "$cursor" -lt $length
            commandline -C $cursor
        else
            commandline -C $length
        end
        commandline -f repaint
        __shelly_emit "line-set;$request"
    end

    # Show the file's one-line notice (`notice <request>`, then the text)
    # below the line, which is drawn again, unchanged, under it. The file is
    # removed once read.
    function __shelly_line_notice
        set -l file $__shelly_line_file
        test -n "$file" -a -f "$file" -a ! -L "$file"; or return
        set -l header
        set -l text
        begin
            read header
            read text
        end < $file
        # Any other request belongs to another key.
        string match -qr -- '^notice [0-9]+$' "$header"; or return
        set -l request (string replace -- 'notice ' '' "$header")
        command rm -f -- $file
        echo
        printf '%s\n' "$text"
        commandline -f repaint
        __shelly_emit "line-set;$request"
    end

    # In every mode: default (emacs-like) and vi's insert and visual modes.
    for __shelly_mode in default insert visual
        if string match -qr '^[0-3]\.' -- $version
            # fish 3 matches raw sequences.
            bind -M $__shelly_mode \e\[24\;16~ __shelly_line_capture
            bind -M $__shelly_mode \e\[23\;16~ __shelly_line_set
            bind -M $__shelly_mode \e\[19\;16~ __shelly_line_notice
            bind -M $__shelly_mode \e\[20\;16~ __shelly_line_query
        else
            bind -M $__shelly_mode ctrl-alt-shift-super-f12 __shelly_line_capture
            bind -M $__shelly_mode ctrl-alt-shift-super-f11 __shelly_line_set
            bind -M $__shelly_mode ctrl-alt-shift-super-f8 __shelly_line_notice
            bind -M $__shelly_mode ctrl-alt-shift-super-f9 __shelly_line_query
        end
    end
    __shelly_emit 'line-editor;capture,set,notice,query'
end
