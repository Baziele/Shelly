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
	f := NewMarkerFilter(&out, hist, nil)

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
	f := NewMarkerFilter(&out, hist, nil)

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
	f := NewMarkerFilter(&out, hist, nil)

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
	f := NewMarkerFilter(&out, hist, nil)

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
	f := NewMarkerFilter(&out, hist, nil)

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
	f := NewMarkerFilter(&out, hist, nil)

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
	f := NewMarkerFilter(&out, hist, nil)

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
	handler := func(question string) (string, error) {
		return "answer to " + question, nil
	}
	f := NewMarkerFilter(&out, hist, handler)

	question := "what can you do"
	qr := fmt.Sprintf("\033]777;shelly;qr=%s\007", base64.StdEncoding.EncodeToString([]byte(question)))
	if _, err := f.Write([]byte(qr)); err != nil {
		t.Fatalf("write: %v", err)
	}

	if !strings.Contains(out.String(), "answer to what can you do") {
		t.Errorf("output missing response, got: %q", out.String())
	}
}
