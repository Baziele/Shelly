package history

import (
	"fmt"
	"testing"
)


func TestHistoryRetainsCommandAndExitCode(t *testing.T) {
	h := New()
	h.Add("ls -la", 0, "", "")

	entries := h.Entries()
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

func TestHistoryRetainsLastTenCommands(t *testing.T) {
	h := New()
	for i := 0; i < 12; i++ {
		h.Add(fcmd(i), i, "", "")
	}

	entries := h.Entries()
	if len(entries) != 10 {
		t.Fatalf("expected 10 entries, got %d", len(entries))
	}
	for i, e := range entries {
		want := 2 + i
		if e.RawInput != fcmd(want) {
			t.Errorf("entry %d RawInput = %q, want %q", i, e.RawInput, fcmd(want))
		}
		if e.ExitCode != want {
			t.Errorf("entry %d ExitCode = %d, want %d", i, e.ExitCode, want)
		}
	}
}

func fcmd(i int) string {
	return fmt.Sprintf("cmd%d", i)
}

func TestHistoryReturnsEmptySliceWhenNoCommands(t *testing.T) {
	h := New()
	entries := h.Entries()
	if entries == nil || len(entries) != 0 {
		t.Errorf("expected empty non-nil slice, got %v", entries)
	}
}

func TestHistoryEntriesAreCopied(t *testing.T) {
	h := New()
	h.Add("first", 0, "", "")

	entries := h.Entries()
	entries[0].RawInput = "mutated"

	if h.Entries()[0].RawInput != "first" {
		t.Error("history entry was mutated through returned slice")
	}
}

func TestHistoryRetainsCleanOutput(t *testing.T) {
	h := New()
	h.Add("ls -la", 0, "raw output", "clean output")

	entries := h.Entries()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Output != "raw output" {
		t.Errorf("Output = %q, want %q", entries[0].Output, "raw output")
	}
	if entries[0].CleanOutput != "clean output" {
		t.Errorf("CleanOutput = %q, want %q", entries[0].CleanOutput, "clean output")
	}
}
