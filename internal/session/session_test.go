package session

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"
)

func TestNewGathersStaticContext(t *testing.T) {
	s, err := New("/bin/bash")
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}

	ctx := s.StaticContext()
	if ctx == nil {
		t.Fatal("StaticContext is nil")
	}
	if ctx.OS != runtime.GOOS {
		t.Errorf("OS = %q, want %q", ctx.OS, runtime.GOOS)
	}
	if ctx.Shell != "bash" {
		t.Errorf("Shell = %q, want %q", ctx.Shell, "bash")
	}
	if ctx.WorkingDirectory == "" {
		t.Error("WorkingDirectory is empty")
	}
}

func TestDumpContextIncludesStaticContextAndHistory(t *testing.T) {
	s, err := New("/bin/bash")
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}
	s.CommandHistory().Add("ls -la", 0, "", "")

	var buf strings.Builder
	if err := s.DumpContext(&buf); err != nil {
		t.Fatalf("DumpContext failed: %v", err)
	}

	out := buf.String()
	if !strings.Contains(out, "static_context") {
		t.Error("dump missing static_context")
	}
	if !strings.Contains(out, "command_history") {
		t.Error("dump missing command_history")
	}
	if !strings.Contains(out, "ls -la") {
		t.Error("dump missing command raw input")
	}
	if !strings.Contains(out, "output_context") {
		t.Error("dump missing output_context")
	}
}

func TestDumpContextIncludesOutputContext(t *testing.T) {
	s, err := New("/bin/bash")
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}
	s.CommandHistory().Add("ls -la", 0, "file1\nfile2", "file1\nfile2")
	s.CommandHistory().Add("echo hi", 0, "hi", "hi")

	var buf strings.Builder
	if err := s.DumpContext(&buf); err != nil {
		t.Fatalf("DumpContext failed: %v", err)
	}

	out := buf.String()
	if !strings.Contains(out, "output_context") {
		t.Error("dump missing output_context")
	}
	if !strings.Contains(out, "file1") {
		t.Error("dump missing output content")
	}
	if !strings.Contains(out, "hi") {
		t.Error("dump missing second output content")
	}
}

func TestNewFallsBackToShWhenShellEmpty(t *testing.T) {
	s, err := New("")
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}
	if s.shellPath != "/bin/sh" {
		t.Errorf("shellPath = %q, want %q", s.shellPath, "/bin/sh")
	}
	if s.StaticContext().Shell != "sh" {
		t.Errorf("Shell = %q, want %q", s.StaticContext().Shell, "sh")
	}
}

func TestSessionCapturesBashCommandHistory(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}

	s, err := New("/bin/bash")
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}
	s.cwdPollInterval = 10 * time.Second // Avoid racing the CWD poller.
	s.Env = []string{"PS1=SHELL_PROMPT ", "HISTFILE=/dev/null"}

	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	s.Stdin = stdinR
	s.Stdout = stdoutW

	done := make(chan error, 1)
	go func() { done <- s.Run() }()

	// Bash startup can be slow; wait for the prompt.
	if err := expectOnReader(stdoutR, "SHELL_PROMPT", 5*time.Second); err != nil {
		t.Fatalf("wait for prompt: %v", err)
	}

	if _, err := stdinW.Write([]byte("echo HELLO\n")); err != nil {
		t.Fatalf("write command: %v", err)
	}
	if err := expectOnReader(stdoutR, "HELLO", 5*time.Second); err != nil {
		t.Fatalf("wait for output: %v", err)
	}
	if err := expectOnReader(stdoutR, "SHELL_PROMPT", 5*time.Second); err != nil {
		t.Fatalf("wait for next prompt: %v", err)
	}

	entries := s.CommandHistory().Entries()
	if len(entries) != 1 {
		t.Fatalf("expected 1 history entry, got %d: %+v", len(entries), entries)
	}
	if entries[0].RawInput != "echo HELLO" {
		t.Errorf("RawInput = %q, want %q", entries[0].RawInput, "echo HELLO")
	}
	if entries[0].ExitCode != 0 {
		t.Errorf("ExitCode = %d, want 0", entries[0].ExitCode)
	}

	if _, err := stdinW.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	_ = stdinW.Close()
	_ = stdoutW.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("session did not exit")
	}
}

func expectOnReader(r *io.PipeReader, want string, timeout time.Duration) error {
	buf := make([]byte, 1024)
	deadline := time.Now().Add(timeout)
	var out strings.Builder
	for time.Now().Before(deadline) {
		n, err := r.Read(buf)
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				continue
			}
			return err
		}
		out.Write(buf[:n])
		if strings.Contains(out.String(), want) {
			return nil
		}
	}
	return fmt.Errorf("expected %q, got %q", want, out.String())
}

func TestSessionRefreshesWorkingDirectoryWhenShellChangesDirectory(t *testing.T) {
	s, err := New("/bin/sh")
	if err != nil {
		t.Fatalf("New failed: %v", err)
	}

	// Start a real shell so we can change its working directory.
	cmd := exec.Command("/bin/sh")
	ptmx, err := pty.Start(cmd)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()

	s.cmd = cmd
	s.cwdPollInterval = 50 * time.Millisecond
	go s.pollWorkingDirectory()
	defer close(s.stopCwdPoll)

	// Wait for the initial prompt and then change directory.
	if err := waitForPrompt(ptmx, 2*time.Second); err != nil {
		t.Fatalf("wait for prompt: %v", err)
	}

	if _, err := ptmx.Write([]byte("cd /tmp\n")); err != nil {
		t.Fatalf("write cd: %v", err)
	}

	// Wait for the poller to observe the new working directory.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.StaticContext().WorkingDirectory == "/tmp" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("WorkingDirectory = %q, want %q", s.StaticContext().WorkingDirectory, "/tmp")
}

func waitForPrompt(r *os.File, timeout time.Duration) error {
	buf := make([]byte, 1024)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_ = r.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		_, err := r.Read(buf)
		if err != nil {
			if os.IsTimeout(err) {
				continue
			}
			return err
		}
		// Any output from the shell means the prompt is ready.
		return nil
	}
	return os.ErrDeadlineExceeded
}
