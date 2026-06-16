package hooks

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/baziele/shelly/internal/history"
	"github.com/baziele/shelly/internal/outputcontext"
)

// MarkerPrefix is the OSC payload prefix Shelly uses to identify its own
// markers in the PTY output stream.
const MarkerPrefix = "777;shelly;"

// QuickRequestResult is returned by a QuickRequestHandler. A non-empty Command
// is written into the User Shell input line via the PTY.
type QuickRequestResult struct {
	Explanation string
	Command     string
}

// QuickRequestHandler is called when a shell hook reports that the user
// submitted a line starting with ": ". It returns the response text to render
// inline and an optional command to populate on the User Shell input line.
type QuickRequestHandler func(question string) (QuickRequestResult, error)

// AutoCommandHandler is called when a shell hook reports that the user
// submitted a line starting with "; ". It returns the command to execute
// immediately through the User Shell.
type AutoCommandHandler func(request string) (string, error)

// MarkerFilter wraps an io.Writer, removes Shelly command-boundary markers
// from the byte stream, records the decoded commands in a History, and
// captures the output associated with each command.
type MarkerFilter struct {
	w       io.Writer
	pty     io.Writer
	history *history.History
	qr      QuickRequestHandler
	autoCmd AutoCommandHandler
	buf     []byte
	output  []byte
}

// NewMarkerFilter creates a filter that writes non-marker output to w and
// records parsed commands in hist. If qr is non-nil, quick-request markers
// emitted by shell hooks are handled by calling qr and writing the returned
// text to w. When qr returns a Command and pty is non-nil, the command is
// populated on the User Shell input line by simulating keystrokes through the
// PTY. If autoCmd is non-nil, auto-command markers are handled by calling
// autoCmd and writing the returned command to pty followed by a newline so it
// executes immediately.
func NewMarkerFilter(w io.Writer, pty io.Writer, hist *history.History, qr QuickRequestHandler, autoCmd AutoCommandHandler) *MarkerFilter {
	return &MarkerFilter{w: w, pty: pty, history: hist, qr: qr, autoCmd: autoCmd}
}

// write passes p to the underlying writer and also appends it to the output
// buffer so it can be associated with the next command marker.
func (f *MarkerFilter) write(p []byte) error {
	_, err := f.w.Write(p)
	f.output = append(f.output, p...)
	return err
}

// Write implements io.Writer. It buffers partial OSC sequences and strips
// Shelly markers while passing everything else through to the underlying
// writer.
func (f *MarkerFilter) Write(p []byte) (int, error) {
	f.buf = append(f.buf, p...)
	for {
		consumed, err := f.flush()
		if err != nil {
			return len(p), err
		}
		if !consumed {
			break
		}
	}
	return len(p), nil
}

// flush processes one chunk from the buffer. It returns true when progress was
// made and false when the buffer ends with an incomplete OSC sequence.
func (f *MarkerFilter) flush() (bool, error) {
	if len(f.buf) == 0 {
		return false, nil
	}

	osc := bytes.Index(f.buf, []byte{0x1b, ']'})
	if osc == -1 {
		// No OSC start in buffer; flush everything as plain text.
		err := f.write(f.buf)
		f.buf = f.buf[:0]
		return false, err
	}

	if osc > 0 {
		// Plain text before the OSC.
		err := f.write(f.buf[:osc])
		f.buf = f.buf[osc:]
		return true, err
	}

	// f.buf starts with ESC]. Find the terminator (BEL or ST).
	content := f.buf[2:]
	contentEnd, termLen := oscTerminator(content)
	if contentEnd == -1 {
		// Incomplete OSC; keep buffered.
		return false, nil
	}

	payload := content[:contentEnd]
	if bytes.HasPrefix(payload, []byte(MarkerPrefix)) {
		if err := f.parseMarker(payload[len(MarkerPrefix):]); err != nil {
			// Malformed marker: drop it silently so output is not corrupted.
		}
	} else {
		// Not a Shelly marker; pass the whole OSC through unchanged.
		if err := f.write(f.buf[:2+contentEnd+termLen]); err != nil {
			return true, err
		}
	}
	f.buf = f.buf[2+contentEnd+termLen:]
	return true, nil
}

// oscTerminator scans an OSC payload and returns the end index of the content
// and the length of the terminator (1 for BEL, 2 for ST). It returns -1 when
// the terminator is not yet present.
func oscTerminator(buf []byte) (int, int) {
	for i := 0; i < len(buf); i++ {
		if buf[i] == '\x07' {
			return i, 1
		}
		if buf[i] == '\x1b' && i+1 < len(buf) && buf[i+1] == '\\' {
			return i, 2
		}
	}
	return -1, 0
}

func (f *MarkerFilter) parseMarker(payload []byte) error {
	if bytes.HasPrefix(payload, []byte("qr=")) {
		return f.parseQuickRequest(payload[len("qr="):])
	}
	if bytes.HasPrefix(payload, []byte("ac=")) {
		return f.parseAutoCommand(payload[len("ac="):])
	}

	parts := bytes.SplitN(payload, []byte(";"), 2)
	if len(parts) != 2 || !bytes.HasPrefix(parts[0], []byte("cmd=")) || !bytes.HasPrefix(parts[1], []byte("exit=")) {
		return fmt.Errorf("malformed marker")
	}

	cmdEnc := string(parts[0][len("cmd="):])
	cmd, err := base64.StdEncoding.DecodeString(cmdEnc)
	if err != nil {
		return err
	}

	exitStr := string(parts[1][len("exit="):])
	exit, err := strconv.Atoi(strings.TrimSpace(exitStr))
	if err != nil {
		return err
	}

	f.history.Add(string(cmd), exit, string(f.output), outputcontext.Clean(string(f.output)))
	f.output = f.output[:0]
	return nil
}

func (f *MarkerFilter) parseQuickRequest(payload []byte) error {
	if f.qr == nil {
		return nil
	}

	questionEnc := string(payload)
	question, err := base64.StdEncoding.DecodeString(questionEnc)
	if err != nil {
		return err
	}

	resp, err := f.qr(string(question))
	if err != nil {
		fmt.Fprintf(f.w, "\r\nshelly: error: %v\r\n", err)
		return nil
	}
	fmt.Fprintf(f.w, "\r\n%s\r\n", strings.TrimRight(resp.Explanation, "\n"))

	if resp.Command != "" && f.pty != nil {
		// Clear the current input line (Ctrl+A to beginning, Ctrl+K to kill
		// to end) before populating the suggested command.
		const clearLine = "\x01\x0b"
		if _, err := f.pty.Write([]byte(clearLine + resp.Command)); err != nil {
			return err
		}
	}
	return nil
}

func (f *MarkerFilter) parseAutoCommand(payload []byte) error {
	if f.autoCmd == nil || f.pty == nil {
		return nil
	}

	requestEnc := string(payload)
	request, err := base64.StdEncoding.DecodeString(requestEnc)
	if err != nil {
		return err
	}

	cmd, err := f.autoCmd(string(request))
	if err != nil {
		fmt.Fprintf(f.w, "\r\nshelly: error: %v\r\n", err)
		return nil
	}

	if cmd != "" {
		if _, err := f.pty.Write([]byte(cmd + "\n")); err != nil {
			return err
		}
	}
	return nil
}
