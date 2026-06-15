package session

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/baziele/shelly/internal/context"
	"github.com/baziele/shelly/internal/history"
	"github.com/baziele/shelly/internal/hooks"
	"github.com/creack/pty"
	"golang.org/x/term"
)

// Session wraps the User Shell behind a PTY and maintains the context that
// Shelly needs to answer questions and run commands.
type Session struct {
	shellPath       string
	cmd             *exec.Cmd
	ptmx            *os.File
	staticCtx       *staticcontext.StaticContext
	history         *history.History
	cwdPollInterval time.Duration
	stopCwdPoll     chan struct{}
	hookCleanup     func()

	// Stdin and Stdout default to os.Stdin and os.Stdout. They can be changed
	// before Run is called to make Session testable without a real terminal.
	Stdin  io.Reader
	Stdout io.Writer

	// Env is appended to the process environment for the User Shell.
	Env []string
}

// New creates a Session for the given shell executable. It gathers the initial
// Static Context immediately so it is available before Run is called.
func New(shell string) (*Session, error) {
	if shell == "" {
		shell = "/bin/sh"
	}

	ctx, err := staticcontext.Gather(shell)
	if err != nil {
		return nil, err
	}

	return &Session{
		shellPath:       shell,
		staticCtx:       ctx,
		history:         history.New(),
		cwdPollInterval: 500 * time.Millisecond,
		stopCwdPoll:     make(chan struct{}),
		Stdin:           os.Stdin,
		Stdout:          os.Stdout,
	}, nil
}

// StaticContext returns the always-included metadata for this Session. The
// returned value must not be modified by callers.
func (s *Session) StaticContext() *staticcontext.StaticContext {
	return s.staticCtx
}

// CommandHistory returns the retained completed commands for this Session. The
// returned value must not be modified by callers.
func (s *Session) CommandHistory() *history.History {
	return s.history
}

// ContextSnapshot holds all Session context tiers in a form suitable for
// debugging or LLM prompts.
type ContextSnapshot struct {
	StaticContext  *staticcontext.StaticContext `json:"static_context"`
	CommandHistory []history.Entry              `json:"command_history"`
	OutputContext  []string                     `json:"output_context"`
}

// DumpContext writes a JSON snapshot of the current Session context to w.
func (s *Session) DumpContext(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(ContextSnapshot{
		StaticContext:  s.staticCtx,
		CommandHistory: s.history.Entries(),
		OutputContext:  nil,
	})
}

// Run starts the User Shell behind a PTY and proxies all input/output between
// it and the configured Stdin/Stdout. It returns when the shell process exits.
func (s *Session) Run() error {
	cmd := exec.Command(s.shellPath)
	cmd.Env = append(os.Environ(), s.Env...)

	inj := &hooks.Injector{OptOut: os.Getenv("SHELLY_DISABLE_HOOKS") != ""}
	cleanup, err := inj.Inject(cmd, s.staticCtx.Shell)
	if err != nil {
		// Injection failures are non-fatal: fall back to prompt-pattern detection.
		cleanup = func() {}
	}
	s.hookCleanup = cleanup
	defer cleanup()

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return err
	}
	s.cmd = cmd
	s.ptmx = ptmx
	defer ptmx.Close()

	// Match the PTY size to the parent terminal and keep it in sync.
	if stdinFile, ok := s.Stdin.(*os.File); ok {
		_ = pty.InheritSize(stdinFile, ptmx)
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGWINCH)
		go func() {
			for range ch {
				_ = pty.InheritSize(stdinFile, ptmx)
			}
		}()
		ch <- syscall.SIGWINCH

		// Put the parent terminal into raw mode so input is forwarded character-by
		// character and programs like vim/less see a real interactive terminal.
		oldState, err := term.MakeRaw(int(stdinFile.Fd()))
		if err == nil {
			defer func() { _ = term.Restore(int(stdinFile.Fd()), oldState) }()
		}
	}

	// Keep the working directory in Static Context up to date as the user cd's
	// around the filesystem.
	go s.pollWorkingDirectory()

	// stdin -> PTY
	go func() { _, _ = io.Copy(ptmx, s.Stdin) }()

	// PTY -> stdout, filtering out Shelly markers and recording commands.
	filter := hooks.NewMarkerFilter(s.Stdout, s.history)
	_, err = io.Copy(filter, ptmx)
	if err != nil && !errors.Is(err, syscall.EIO) {
		return err
	}

	close(s.stopCwdPoll)

	if cmd.Process != nil {
		_ = cmd.Wait()
	}
	return nil
}

func (s *Session) pollWorkingDirectory() {
	ticker := time.NewTicker(s.cwdPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			s.refreshWorkingDirectory()
		case <-s.stopCwdPoll:
			return
		}
	}
}

func (s *Session) refreshWorkingDirectory() {
	if s.cmd == nil || s.cmd.Process == nil {
		return
	}
	_ = s.staticCtx.RefreshFromProcess(s.cmd.Process.Pid)
}
