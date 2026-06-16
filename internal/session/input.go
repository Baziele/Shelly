package session

import (
	"fmt"
	"io"
	"strings"
)

// inputProxy intercepts stdin -> PTY and detects Quick Request patterns.
// It forwards every keystroke to the shell unchanged, so the terminal behaves
// exactly like a normal shell prompt. Only after the user presses Enter does it
// check whether the submitted line starts with ": " and, if so, handles it as a
// Quick Request.
type inputProxy struct {
	stdin   io.Reader
	pty     io.Writer
	stdout  io.Writer
	handler func(string) (string, error)
}

// run reads from stdin and forwards to PTY, inspecting completed lines for the
// Quick Request prefix.
func (p *inputProxy) run() {
	buf := make([]byte, 1)
	var line []byte

	for {
		n, err := p.stdin.Read(buf)
		if n == 0 || err != nil {
			break
		}
		b := buf[0]

		if b == '\n' || b == '\r' {
			if isQuickRequest(line) {
				p.handleQuickRequest(string(line[2:]), b)
				line = line[:0]
				continue
			}
			line = line[:0]
			p.pty.Write([]byte{b})
			continue
		}

		// Accumulate the line locally so we can inspect it on Enter, while still
		// forwarding every byte to the shell for normal editing behavior.
		line = append(line, b)
		p.pty.Write([]byte{b})
	}
}

func isQuickRequest(line []byte) bool {
	return len(line) >= 2 && line[0] == ':' && line[1] == ' '
}

func (p *inputProxy) handleQuickRequest(question string, enter byte) {
	resp, err := p.handler(question)
	if err != nil {
		fmt.Fprintf(p.stdout, "\nshelly: error: %v", err)
	} else {
		fmt.Fprintf(p.stdout, "\n%s", strings.TrimRight(resp, "\n"))
	}
	// Now submit the Enter to the shell so the prompt returns after the response.
	p.pty.Write([]byte{enter})
}
