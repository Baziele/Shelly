package outputcontext

import (
	"strings"
	"testing"

	"github.com/baziele/shelly/internal/history"
)

func TestStripANSIRemovesColorCodes(t *testing.T) {
	input := "\x1b[31mred\x1b[0m text"
	want := "red text"
	got := StripANSI(input)
	if got != want {
		t.Errorf("StripANSI(%q) = %q, want %q", input, got, want)
	}
}

func TestStripANSIRemovesCursorMovement(t *testing.T) {
	input := "\x1b[2K\x1b[1Gcleared line"
	want := "cleared line"
	got := StripANSI(input)
	if got != want {
		t.Errorf("StripANSI(%q) = %q, want %q", input, got, want)
	}
}

func TestStripANSILeavesPlainTextUnchanged(t *testing.T) {
	input := "plain text without escapes"
	got := StripANSI(input)
	if got != input {
		t.Errorf("StripANSI(%q) = %q, want %q", input, got, input)
	}
}

func TestStripANSIRemovesComplexSequence(t *testing.T) {
	input := "\x1b[1;32m\x1b[42m\x1b[5m"
	want := ""
	got := StripANSI(input)
	if got != want {
		t.Errorf("StripANSI(%q) = %q, want %q", input, got, want)
	}
}

func TestCollapseProgressBarsKeepsFinalLineState(t *testing.T) {
	input := "10% [===       ]\r20% [======    ]\r30% [========  ]"
	want := "30% [========  ]"
	got := CollapseProgressBars(input)
	if got != want {
		t.Errorf("CollapseProgressBars(%q) = %q, want %q", input, got, want)
	}
}

func TestCollapseProgressBarsHandlesMultipleLines(t *testing.T) {
	input := "header\n10%\r20%\r30%\nfooter"
	want := "header\n30%\nfooter"
	got := CollapseProgressBars(input)
	if got != want {
		t.Errorf("CollapseProgressBars(%q) = %q, want %q", input, got, want)
	}
}

func TestCollapseProgressBarsLeavesPlainTextUnchanged(t *testing.T) {
	input := "plain text\nwithout carriage returns"
	got := CollapseProgressBars(input)
	if got != input {
		t.Errorf("CollapseProgressBars(%q) = %q, want %q", input, got, input)
	}
}

func TestCollapseBlankLinesCollapsesRepeatedEmptyLines(t *testing.T) {
	input := "line1\n\n\n\nline2\n\n\nline3"
	want := "line1\n\nline2\n\nline3"
	got := CollapseBlankLines(input)
	if got != want {
		t.Errorf("CollapseBlankLines(%q) = %q, want %q", input, got, want)
	}
}

func TestCollapseBlankLinesLeavesSingleBlankLines(t *testing.T) {
	input := "line1\n\nline2"
	got := CollapseBlankLines(input)
	if got != input {
		t.Errorf("CollapseBlankLines(%q) = %q, want %q", input, got, input)
	}
}

func TestCollapseBlankLinesHandlesNoBlankLines(t *testing.T) {
	input := "line1\nline2\nline3"
	got := CollapseBlankLines(input)
	if got != input {
		t.Errorf("CollapseBlankLines(%q) = %q, want %q", input, got, input)
	}
}

func TestSummarizeReturnsShortInputUnchanged(t *testing.T) {
	input := "short text"
	got := Summarize(input, 100)
	if got != input {
		t.Errorf("Summarize(%q, 100) = %q, want %q", input, got, input)
	}
}

func TestSummarizeTruncatesLongInput(t *testing.T) {
	input := strings.Repeat("a", 100) + "\n" + strings.Repeat("b", 100)
	got := Summarize(input, 50)
	if len(got) > 50 {
		t.Errorf("Summarize len = %d, want <= 50", len(got))
	}
	if !strings.Contains(got, "...") {
		t.Errorf("Summarize missing truncation marker: %q", got)
	}
	if !strings.HasPrefix(got, strings.Repeat("a", 10)) {
		t.Errorf("Summarize missing head: %q", got)
	}
	if !strings.HasSuffix(got, strings.Repeat("b", 10)) {
		t.Errorf("Summarize missing tail: %q", got)
	}
}

func TestSummarizeRespectsExactByteLimit(t *testing.T) {
	input := strings.Repeat("x", 1000)
	got := Summarize(input, 100)
	if len(got) > 100 {
		t.Errorf("Summarize len = %d, want <= 100", len(got))
	}
}

func TestBuildReturnsCleanedOutputs(t *testing.T) {
	entries := []history.Entry{
		{RawInput: "ls", ExitCode: 0, CleanOutput: "file1\nfile2"},
	}
	got := Build(entries, 1000)
	if len(got) != 1 {
		t.Fatalf("expected 1 output, got %d", len(got))
	}
	if got[0] != "file1\nfile2" {
		t.Errorf("Build output = %q, want %q", got[0], "file1\nfile2")
	}
}

func TestBuildAppliesSixKBCap(t *testing.T) {
	entries := []history.Entry{
		{RawInput: "cmd1", ExitCode: 0, CleanOutput: strings.Repeat("a", 3000)},
		{RawInput: "cmd2", ExitCode: 0, CleanOutput: strings.Repeat("b", 3000)},
		{RawInput: "cmd3", ExitCode: 0, CleanOutput: strings.Repeat("c", 3000)},
	}
	got := Build(entries, 6000)
	var total int
	for _, o := range got {
		total += len(o)
	}
	if total > 6000 {
		t.Errorf("total output = %d, want <= 6000", total)
	}
}

func TestBuildPrioritizesRecentOutputs(t *testing.T) {
	entries := []history.Entry{
		{RawInput: "old", ExitCode: 0, CleanOutput: "old-output"},
		{RawInput: "new", ExitCode: 0, CleanOutput: "new-output"},
	}
	got := Build(entries, 12)
	if len(got) != 1 {
		t.Fatalf("expected 1 output, got %d", len(got))
	}
	if got[0] != "new-output" {
		t.Errorf("Build output = %q, want %q", got[0], "new-output")
	}
}

func TestBuildSummarizesOversizedOutputs(t *testing.T) {
	entries := []history.Entry{
		{RawInput: "cmd", ExitCode: 0, CleanOutput: strings.Repeat("x", 10000)},
	}
	got := Build(entries, 6000)
	if len(got) != 1 {
		t.Fatalf("expected 1 output, got %d", len(got))
	}
	if len(got[0]) > 2048 {
		t.Errorf("summarized output = %d, want <= 2048", len(got[0]))
	}
	if !strings.Contains(got[0], "...") {
		t.Errorf("expected truncation marker, got %q", got[0])
	}
}
