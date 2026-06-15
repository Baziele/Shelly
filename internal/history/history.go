// Package history stores the recent command history for a Session.
package history

const maxEntries = 10

// Entry records a single command that completed in the User Shell.
type Entry struct {
	RawInput string
	ExitCode int
}

// History retains the most recent completed commands, bounded by maxEntries.
type History struct {
	entries []Entry
}

// New creates an empty History.
func New() *History {
	return &History{}
}

// Add records a completed command. If the buffer is full, the oldest entry is
// discarded.
func (h *History) Add(raw string, exit int) {
	if len(h.entries) >= maxEntries {
		h.entries = h.entries[1:]
	}
	h.entries = append(h.entries, Entry{RawInput: raw, ExitCode: exit})
}

// Entries returns a copy of the retained entries in chronological order
// (oldest first).
func (h *History) Entries() []Entry {
	out := make([]Entry, len(h.entries))
	copy(out, h.entries)
	return out
}
