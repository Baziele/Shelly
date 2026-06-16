// Package outputcontext cleans and summarizes command outputs for the Output
// Context tier.
package outputcontext

import (
	"regexp"
	"strings"

	"github.com/baziele/shelly/internal/history"
)

// ansiPattern matches ANSI escape sequences.
// It covers CSI (Control Sequence Introducer) sequences like \x1b[...m
// and other escape sequences.
var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)

// StripANSI removes ANSI escape sequences from s.
func StripANSI(s string) string {
	return ansiPattern.ReplaceAllString(s, "")
}

// CollapseProgressBars removes carriage-return overwrite spam from s. For each
// line, only the text after the final \r is retained, unless the \r is at the
// end of the line (e.g. \r\n line endings).
func CollapseProgressBars(s string) string {
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		if idx := strings.LastIndex(line, "\r"); idx != -1 && idx < len(line)-1 {
			lines[i] = line[idx+1:]
		}
	}
	return strings.Join(lines, "\n")
}

// CollapseBlankLines replaces consecutive blank lines with a single blank line.
func CollapseBlankLines(s string) string {
	lines := strings.Split(s, "\n")
	var out []string
	var blankCount int
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			blankCount++
			if blankCount == 1 {
				out = append(out, line)
			}
		} else {
			blankCount = 0
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

const truncationMarker = "..."

// Summarize returns s unchanged when it is shorter than maxBytes. Otherwise it
// returns a string containing the head and tail of s with a truncation marker in
// between, bounded to maxBytes.
func Summarize(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	markerLen := len(truncationMarker)
	if maxBytes <= markerLen {
		return s[:maxBytes]
	}
	available := maxBytes - markerLen
	headLen := available / 2
	tailLen := available - headLen
	if tailLen > len(s)-headLen {
		tailLen = len(s) - headLen
	}
	if tailLen < 0 {
		tailLen = 0
	}
	return s[:headLen] + truncationMarker + s[len(s)-tailLen:]
}

// Build creates the Output Context from a slice of history entries. It cleans
// each output, applies per-entry summarization when an output exceeds its fair
// share, and respects the total maxBytes budget by prioritizing the most recent
// entries.
func Build(entries []history.Entry, maxBytes int) []string {
	if len(entries) == 0 || maxBytes <= 0 {
		return nil
	}

	fairShare := maxBytes / len(entries)
	if fairShare < 1 {
		fairShare = 1
	}

	var out []string
	remaining := maxBytes

	// Iterate from most recent to oldest.
	for i := len(entries) - 1; i >= 0; i-- {
		cleaned := entries[i].CleanOutput
		processed := cleaned
		if len(cleaned) > fairShare && len(cleaned) > 2048 {
			processed = Summarize(cleaned, 2048)
		}
		if len(processed) > remaining {
			continue
		}
		out = append([]string{processed}, out...)
		remaining -= len(processed)
	}

	return out
}

// Clean applies all output-cleaning steps: strip ANSI, collapse progress bars,
// normalize line endings, and collapse repeated blank lines.
func Clean(s string) string {
	s = StripANSI(s)
	s = CollapseProgressBars(s)
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = CollapseBlankLines(s)
	return s
}
