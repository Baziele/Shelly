package shelly_test

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"
)

var binaryPath string

func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "shelly-test-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(tmp)

	binaryPath = filepath.Join(tmp, "shelly")
	build := exec.Command("go", "build", "-o", binaryPath, "../cmd/shelly")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "build failed:", err)
		os.Exit(1)
	}

	os.Exit(m.Run())
}

func startShelly(t *testing.T, env ...string) (*os.File, *exec.Cmd) {
	t.Helper()
	cmd := exec.Command(binaryPath)
	cmd.Env = append(os.Environ(), env...)

	ptmx, pts, err := pty.Open()
	if err != nil {
		t.Fatalf("open pty: %v", err)
	}
	t.Cleanup(func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	})

	cmd.Stdin = pts
	cmd.Stdout = pts
	cmd.Stderr = pts
	if err := cmd.Start(); err != nil {
		t.Fatalf("start shelly: %v", err)
	}
	_ = pts.Close()

	return ptmx, cmd
}

func expect(t *testing.T, r *os.File, want string, timeout time.Duration) {
	t.Helper()
	_ = readUntil(t, r, want, timeout)
}

func readUntil(t *testing.T, r *os.File, want string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	buf := make([]byte, 1024)
	var out strings.Builder
	for time.Now().Before(deadline) {
		_ = r.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		n, err := r.Read(buf)
		if err != nil {
			if os.IsTimeout(err) {
				continue
			}
			break
		}
		out.Write(buf[:n])
		if strings.Contains(out.String(), want) {
			return out.String()
		}
	}
	t.Fatalf("expected output containing %q within %v, got %q", want, timeout, out.String())
	return out.String()
}

func waitForExit(t *testing.T, cmd *exec.Cmd, timeout time.Duration) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("shelly exited with error: %v", err)
		}
	case <-time.After(timeout):
		t.Fatal("shelly did not exit in time")
	}
}

func TestTracerBullet(t *testing.T) {
	ptmx, cmd := startShelly(t, "SHELL=/bin/sh", "PS1=SHELL_PROMPT ")

	expect(t, ptmx, "SHELL_PROMPT", 3*time.Second)

	if _, err := ptmx.Write([]byte("echo SHELLY_TEST\n")); err != nil {
		t.Fatalf("write command: %v", err)
	}
	expect(t, ptmx, "SHELLY_TEST", 3*time.Second)

	if _, err := ptmx.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	waitForExit(t, cmd, 5*time.Second)
}

func TestCDPersistsAcrossCommands(t *testing.T) {
	ptmx, cmd := startShelly(t, "SHELL=/bin/sh", "PS1=SHELL_PROMPT ")

	expect(t, ptmx, "SHELL_PROMPT", 3*time.Second)
	if _, err := ptmx.Write([]byte("cd /tmp && printf 'WD:%s\n' \"$PWD\"\n")); err != nil {
		t.Fatalf("write cd: %v", err)
	}
	expect(t, ptmx, "WD:/tmp", 3*time.Second)

	if _, err := ptmx.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	waitForExit(t, cmd, 5*time.Second)
}

func TestStdinIsATerminal(t *testing.T) {
	ptmx, cmd := startShelly(t, "SHELL=/bin/sh", "PS1=SHELL_PROMPT ")

	expect(t, ptmx, "SHELL_PROMPT", 3*time.Second)
	if _, err := ptmx.Write([]byte("if [ -t 0 ]; then echo TTY_OK; fi\n")); err != nil {
		t.Fatalf("write tty check: %v", err)
	}
	expect(t, ptmx, "TTY_OK", 3*time.Second)

	if _, err := ptmx.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	waitForExit(t, cmd, 5*time.Second)
}

func TestShellDiscoveredFromEnv(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "custom-shell")
	content := "#!/bin/sh\nprintf 'CUSTOM_SHELL_READY\\n'\nexec /bin/sh \"$@\"\n"
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatalf("write custom shell: %v", err)
	}

	ptmx, cmd := startShelly(t, "SHELL="+script, "PS1=SHELL_PROMPT ")
	expect(t, ptmx, "CUSTOM_SHELL_READY", 3*time.Second)

	if _, err := ptmx.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	waitForExit(t, cmd, 5*time.Second)
}

func TestShellFallbackWhenEmpty(t *testing.T) {
	ptmx, cmd := startShelly(t, "SHELL=", "PS1=SHELL_PROMPT ")

	expect(t, ptmx, "SHELL_PROMPT", 3*time.Second)
	if _, err := ptmx.Write([]byte("echo FALLBACK_TEST\n")); err != nil {
		t.Fatalf("write command: %v", err)
	}
	expect(t, ptmx, "FALLBACK_TEST", 3*time.Second)

	if _, err := ptmx.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	waitForExit(t, cmd, 5*time.Second)
}

func TestInteractiveProgramReadsInput(t *testing.T) {
	ptmx, cmd := startShelly(t, "SHELL=/bin/sh", "PS1=SHELL_PROMPT ")

	expect(t, ptmx, "SHELL_PROMPT", 3*time.Second)
	if _, err := ptmx.Write([]byte("read -r line && echo \"READ:$line\"\n")); err != nil {
		t.Fatalf("write read command: %v", err)
	}
	if _, err := ptmx.Write([]byte("shelly-interactive-input\n")); err != nil {
		t.Fatalf("write input: %v", err)
	}
	expect(t, ptmx, "READ:shelly-interactive-input", 3*time.Second)

	if _, err := ptmx.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	waitForExit(t, cmd, 5*time.Second)
}

func TestBashSessionProxiesCommandsWithHooks(t *testing.T) {
	ptmx, cmd := startShelly(t, "SHELL=/bin/bash", "PS1=SHELL_PROMPT ", "HISTFILE=/dev/null")

	expect(t, ptmx, "SHELL_PROMPT", 3*time.Second)
	if _, err := ptmx.Write([]byte("echo BASH_HOOKS_OK\n")); err != nil {
		t.Fatalf("write command: %v", err)
	}
	expect(t, ptmx, "BASH_HOOKS_OK", 3*time.Second)

	if _, err := ptmx.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	waitForExit(t, cmd, 5*time.Second)
}

func TestContextDumpOnExit(t *testing.T) {
	dumpPath := filepath.Join(t.TempDir(), "context.json")
	ptmx, cmd := startShelly(t, "SHELL=/bin/bash", "PS1=SHELL_PROMPT ", "HISTFILE=/dev/null", "SHELLY_CONTEXT_DUMP="+dumpPath)

	expect(t, ptmx, "SHELL_PROMPT", 3*time.Second)
	if _, err := ptmx.Write([]byte("echo DUMP_TEST\n")); err != nil {
		t.Fatalf("write command: %v", err)
	}
	expect(t, ptmx, "DUMP_TEST", 3*time.Second)

	if _, err := ptmx.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	waitForExit(t, cmd, 5*time.Second)

	content, err := os.ReadFile(dumpPath)
	if err != nil {
		t.Fatalf("read dump file: %v", err)
	}
	if !strings.Contains(string(content), "static_context") {
		t.Error("dump missing static_context")
	}
	if !strings.Contains(string(content), "command_history") {
		t.Error("dump missing command_history")
	}
	if !strings.Contains(string(content), "echo DUMP_TEST") {
		t.Error("dump missing captured command")
	}
	if !strings.Contains(string(content), "output_context") {
		t.Error("dump missing output_context")
	}
}

func TestContextDumpCapturesCommandOutput(t *testing.T) {
	dumpPath := filepath.Join(t.TempDir(), "context.json")
	ptmx, cmd := startShelly(t, "SHELL=/bin/bash", "PS1=SHELL_PROMPT ", "HISTFILE=/dev/null", "SHELLY_CONTEXT_DUMP="+dumpPath)

	expect(t, ptmx, "SHELL_PROMPT", 3*time.Second)
	if _, err := ptmx.Write([]byte("echo OUTPUT_CAPTURE_TEST\n")); err != nil {
		t.Fatalf("write command: %v", err)
	}
	expect(t, ptmx, "OUTPUT_CAPTURE_TEST", 3*time.Second)

	if _, err := ptmx.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	waitForExit(t, cmd, 5*time.Second)

	content, err := os.ReadFile(dumpPath)
	if err != nil {
		t.Fatalf("read dump file: %v", err)
	}
	if !strings.Contains(string(content), "OUTPUT_CAPTURE_TEST") {
		t.Error("dump missing captured command output")
	}

	var dump struct {
		CommandHistory []struct {
			RawInput    string `json:"RawInput"`
			ExitCode    int    `json:"ExitCode"`
			Output      string `json:"Output"`
			CleanOutput string `json:"CleanOutput"`
		} `json:"command_history"`
		OutputContext []string `json:"output_context"`
	}
	if err := json.Unmarshal(content, &dump); err != nil {
		t.Fatalf("unmarshal dump: %v\n%s", err, content)
	}

	if len(dump.CommandHistory) == 0 {
		t.Fatal("no command history entries")
	}
	if dump.CommandHistory[0].CleanOutput == "" {
		t.Errorf("CleanOutput is empty, Output=%q", dump.CommandHistory[0].Output)
	}
	if len(dump.OutputContext) == 0 {
		t.Error("OutputContext is empty")
	}
	if len(dump.OutputContext) > 0 && !strings.Contains(dump.OutputContext[0], "OUTPUT_CAPTURE_TEST") {
		t.Errorf("OutputContext missing output: %v", dump.OutputContext)
	}
}

func TestQuickRequestRendersInlineResponse(t *testing.T) {
	// Always run — the adapter has defaults if env vars are not set.

	ptmx, cmd := startShelly(t,
		"SHELL=/bin/bash",
		"PS1=SHELL_PROMPT ",
		"HISTFILE=/dev/null",
		"LLM_BASE_URL="+os.Getenv("LLM_BASE_URL"),
		"LLM_API_KEY="+os.Getenv("LLM_API_KEY"),
		"LLM_MODEL=deepseek-v4-flash",
	)

	expect(t, ptmx, "SHELL_PROMPT", 3*time.Second)

	// Type a quick request.
	if _, err := ptmx.Write([]byte(": say hello in one word\n")); err != nil {
		t.Fatalf("write quick request: %v", err)
	}

	// Wait for the prompt to return. The response should appear before it.
	out := readUntil(t, ptmx, "SHELL_PROMPT", 30*time.Second)
	lower := strings.ToLower(out)
	if !strings.Contains(lower, "hello") {
		t.Errorf("quick request response missing 'hello', got: %q", out)
	}

	if _, err := ptmx.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	waitForExit(t, cmd, 5*time.Second)
}

func TestStaticContextFlagPrintsStructuredContext(t *testing.T) {
	cmd := exec.Command(binaryPath, "-static-context")
	cmd.Env = append(os.Environ(), "SHELL=/bin/bash")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("run static-context flag: %v", err)
	}

	var ctx struct {
		OS               string `json:"OS"`
		Shell            string `json:"Shell"`
		WorkingDirectory string `json:"WorkingDirectory"`
		PythonVersion    string `json:"PythonVersion"`
		NodeVersion      string `json:"NodeVersion"`
	}
	if err := json.Unmarshal(out, &ctx); err != nil {
		t.Fatalf("decode static context: %v\noutput: %s", err, out)
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
