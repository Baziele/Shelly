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

// MarkerFilter wraps an io.Writer, removes Shelly command-boundary markers
// from the byte stream, records the decoded commands in a History, and
// captures the output associated with each command.
type MarkerFilter struct {
	w       io.Writer
	history *history.History
	buf     []byte
	output  []byte
}

// NewMarkerFilter creates a filter that writes non-marker output to w and
// records parsed commands in hist.
func NewMarkerFilter(w io.Writer, hist *history.History) *MarkerFilter {
	return &MarkerFilter{w: w, history: hist}
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
