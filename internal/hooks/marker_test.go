package hooks

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"

	"github.com/baziele/shelly/internal/history"
)

func marker(cmd string, exit int) string {
	return fmt.Sprintf("\033]777;shelly;cmd=%s;exit=%d\007", base64.StdEncoding.EncodeToString([]byte(cmd)), exit)
}

func TestMarkerParserExtractsCommandAndExitCode(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	f := NewMarkerFilter(&out, nil, hist, nil, nil, nil)

	input := []byte("before" + marker("ls -la", 0) + "after")
	if _, err := f.Write(input); err != nil {
		t.Fatalf("write: %v", err)
	}

	if out.String() != "beforeafter" {
		t.Errorf("output = %q, want %q", out.String(), "beforeafter")
	}

	entries := hist.Entries()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].RawInput != "ls -la" {
		t.Errorf("RawInput = %q, want %q", entries[0].RawInput, "ls -la")
	}
	if entries[0].ExitCode != 0 {
		t.Errorf("ExitCode = %d, want %d", entries[0].ExitCode, 0)
	}
}

func TestMarkerParserHandlesSplitMarkers(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	f := NewMarkerFilter(&out, nil, hist, nil, nil, nil)

	m := marker("echo hello", 42)
	// Split the marker across two writes.
	if _, err := f.Write([]byte("prefix" + m[:10])); err != nil {
		t.Fatalf("write first part: %v", err)
	}
	if _, err := f.Write([]byte(m[10:] + "suffix")); err != nil {
		t.Fatalf("write second part: %v", err)
	}

	if out.String() != "prefixsuffix" {
		t.Errorf("output = %q, want %q", out.String(), "prefixsuffix")
	}

	entries := hist.Entries()
	if len(entries) != 1 || entries[0].RawInput != "echo hello" || entries[0].ExitCode != 42 {
		t.Errorf("unexpected entry: %+v", entries)
	}
}

func TestMarkerParserIgnoresOtherOSCSequences(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	f := NewMarkerFilter(&out, nil, hist, nil, nil, nil)

	input := []byte("\033]0;window title\007visible")
	if _, err := f.Write(input); err != nil {
		t.Fatalf("write: %v", err)
	}

	if out.String() != string(input) {
		t.Errorf("output = %q, want %q", out.String(), string(input))
	}
	if len(hist.Entries()) != 0 {
		t.Errorf("expected no entries, got %d", len(hist.Entries()))
	}
}

func TestMarkerParserDecodesBase64Command(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	f := NewMarkerFilter(&out, nil, hist, nil, nil, nil)

	cmd := "echo 'hello world' && ls | wc -l"
	input := []byte(marker(cmd, 1))
	if _, err := f.Write(input); err != nil {
		t.Fatalf("write: %v", err)
	}

	entries := hist.Entries()
	if len(entries) != 1 || entries[0].RawInput != cmd {
		t.Errorf("RawInput = %q, want %q", entries[0].RawInput, cmd)
	}
}

func TestMarkerParserCapturesOutputBetweenMarkers(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	f := NewMarkerFilter(&out, nil, hist, nil, nil, nil)

	input := []byte("output1" + marker("cmd1", 0) + "output2" + marker("cmd2", 1))
	if _, err := f.Write(input); err != nil {
		t.Fatalf("write: %v", err)
	}

	entries := hist.Entries()
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[0].Output != "output1" {
		t.Errorf("entry 0 Output = %q, want %q", entries[0].Output, "output1")
	}
	if entries[1].Output != "output2" {
		t.Errorf("entry 1 Output = %q, want %q", entries[1].Output, "output2")
	}
}

func TestMarkerParserCapturesOutputAcrossSplitWrites(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	f := NewMarkerFilter(&out, nil, hist, nil, nil, nil)

	m1 := marker("cmd1", 0)
	if _, err := f.Write([]byte("part1")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := f.Write([]byte("part2" + m1)); err != nil {
		t.Fatalf("write: %v", err)
	}

	entries := hist.Entries()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Output != "part1part2" {
		t.Errorf("Output = %q, want %q", entries[0].Output, "part1part2")
	}
}

func TestMarkerParserCapturesCleanOutput(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	f := NewMarkerFilter(&out, nil, hist, nil, nil, nil)

	input := []byte("output1" + marker("cmd1", 0) + "output2" + marker("cmd2", 1))
	if _, err := f.Write(input); err != nil {
		t.Fatalf("write: %v", err)
	}

	entries := hist.Entries()
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[0].CleanOutput != "output1" {
		t.Errorf("entry 0 CleanOutput = %q, want %q", entries[0].CleanOutput, "output1")
	}
	if entries[1].CleanOutput != "output2" {
		t.Errorf("entry 1 CleanOutput = %q, want %q", entries[1].CleanOutput, "output2")
	}
}

func TestMarkerFilterHandlesQuickRequestMarker(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	handler := func(question string) (QuickRequestResult, error) {
		return QuickRequestResult{Explanation: "answer to " + question}, nil
	}
	f := NewMarkerFilter(&out, nil, hist, handler, nil, nil)

	question := "what can you do"
	qr := fmt.Sprintf("\033]777;shelly;qr=%s\007", base64.StdEncoding.EncodeToString([]byte(question)))
	if _, err := f.Write([]byte(qr)); err != nil {
		t.Fatalf("write: %v", err)
	}

	if !strings.Contains(out.String(), "answer to what can you do") {
		t.Errorf("output missing response, got: %q", out.String())
	}
}

func TestMarkerFilterPopulatesCommandOnPty(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	var pty bytes.Buffer
	handler := func(question string) (QuickRequestResult, error) {
		return QuickRequestResult{Explanation: "ok", Command: "ls -la"}, nil
	}
	f := NewMarkerFilter(&out, &pty, hist, handler, nil, nil)

	question := "list files"
	qr := fmt.Sprintf("\033]777;shelly;qr=%s\007", base64.StdEncoding.EncodeToString([]byte(question)))
	if _, err := f.Write([]byte(qr)); err != nil {
		t.Fatalf("write: %v", err)
	}

	got := pty.String()
	if !strings.Contains(got, "ls -la") {
		t.Errorf("pty missing command, got %q", got)
	}
}

func TestMarkerFilterClearsLineBeforePopulatingCommand(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	var pty bytes.Buffer
	handler := func(question string) (QuickRequestResult, error) {
		return QuickRequestResult{Explanation: "ok", Command: "git status"}, nil
	}
	f := NewMarkerFilter(&out, &pty, hist, handler, nil, nil)

	question := "status"
	qr := fmt.Sprintf("\033]777;shelly;qr=%s\007", base64.StdEncoding.EncodeToString([]byte(question)))
	if _, err := f.Write([]byte(qr)); err != nil {
		t.Fatalf("write: %v", err)
	}

	got := pty.String()
	const clearLine = "\x01\x0b"
	if !strings.HasPrefix(got, clearLine) {
		t.Errorf("pty missing line-clear keystrokes, got %q", got)
	}
	if !strings.Contains(got, "git status") {
		t.Errorf("pty missing command, got %q", got)
	}
}

func TestMarkerFilterExecutesAutoCommand(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	var pty bytes.Buffer
	handler := func(request string) (string, error) {
		return "echo auto", nil
	}
	f := NewMarkerFilter(&out, &pty, hist, nil, handler, nil)

	request := "say auto"
	ac := fmt.Sprintf("\033]777;shelly;ac=%s\007", base64.StdEncoding.EncodeToString([]byte(request)))
	if _, err := f.Write([]byte(ac)); err != nil {
		t.Fatalf("write: %v", err)
	}

	got := pty.String()
	if !strings.Contains(got, "echo auto") {
		t.Errorf("pty missing command, got %q", got)
	}
	if !strings.HasSuffix(got, "\n") {
		t.Errorf("pty command missing newline (should execute), got %q", got)
	}
}

func TestMarkerFilterAutoCommandDoesNotRenderExplanation(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	var pty bytes.Buffer
	handler := func(request string) (string, error) {
		return "echo auto", nil
	}
	f := NewMarkerFilter(&out, &pty, hist, nil, handler, nil)

	request := "say auto"
	ac := fmt.Sprintf("\033]777;shelly;ac=%s\007", base64.StdEncoding.EncodeToString([]byte(request)))
	if _, err := f.Write([]byte(ac)); err != nil {
		t.Fatalf("write: %v", err)
	}

	if out.String() != "" {
		t.Errorf("auto-command rendered unexpected output: %q", out.String())
	}
}

func TestMarkerFilterHandlesAgentModeMarker(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	handler := func(message string) (string, error) {
		return "Agent response to " + message, nil
	}
	f := NewMarkerFilter(&out, nil, hist, nil, nil, handler)

	message := "hello agent"
	am := fmt.Sprintf("\033]777;shelly;am=%s\007", base64.StdEncoding.EncodeToString([]byte(message)))
	if _, err := f.Write([]byte(am)); err != nil {
		t.Fatalf("write: %v", err)
	}

	if !strings.Contains(out.String(), "Agent response to hello agent") {
		t.Errorf("output missing agent response, got: %q", out.String())
	}
}

func TestMarkerFilterAgentModeRendersCompletionMarker(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	handler := func(message string) (string, error) {
		return "done", nil
	}
	f := NewMarkerFilter(&out, nil, hist, nil, nil, handler)

	am := fmt.Sprintf("\033]777;shelly;am=%s\007", base64.StdEncoding.EncodeToString([]byte("test")))
	if _, err := f.Write([]byte(am)); err != nil {
		t.Fatalf("write: %v", err)
	}

	if !strings.Contains(out.String(), "[shelly agent done]") {
		t.Errorf("output missing completion marker, got: %q", out.String())
	}
}

func TestMarkerFilterAgentModeRendersError(t *testing.T) {
	hist := history.New()
	var out bytes.Buffer
	handler := func(message string) (string, error) {
		return "", fmt.Errorf("llm error")
	}
	f := NewMarkerFilter(&out, nil, hist, nil, nil, handler)

	am := fmt.Sprintf("\033]777;shelly;am=%s\007", base64.StdEncoding.EncodeToString([]byte("test")))
	if _, err := f.Write([]byte(am)); err != nil {
		t.Fatalf("write: %v", err)
	}

	if !strings.Contains(out.String(), "shelly: agent error: llm error") {
		t.Errorf("output missing error message, got: %q", out.String())
	}
}
