package staticcontext

import (
	"os"
	"os/exec"
	"runtime"
	"testing"
)

func TestGatherDetectsOSShellAndCWD(t *testing.T) {
	origWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	dir := t.TempDir()
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer os.Chdir(origWD) // Reset cwd after test.

	ctx, err := Gather("/bin/bash")
	if err != nil {
		t.Fatalf("Gather failed: %v", err)
	}

	if ctx.OS != runtime.GOOS {
		t.Errorf("OS = %q, want %q", ctx.OS, runtime.GOOS)
	}
	if ctx.Shell != "bash" {
		t.Errorf("Shell = %q, want %q", ctx.Shell, "bash")
	}
	if ctx.WorkingDirectory != dir {
		t.Errorf("WorkingDirectory = %q, want %q", ctx.WorkingDirectory, dir)
	}
}

func TestGatherDetectsPythonVersionWhenAvailable(t *testing.T) {
	ctx, err := Gather("/bin/sh")
	if err != nil {
		t.Fatalf("Gather failed: %v", err)
	}

	if _, err := exec.LookPath("python3"); err == nil {
		if ctx.PythonVersion == "" {
			t.Error("PythonVersion is empty but python3 is available")
		}
	} else if ctx.PythonVersion != "" {
		t.Errorf("PythonVersion = %q, want empty when python is missing", ctx.PythonVersion)
	}
}

func TestGatherDetectsNodeVersionWhenAvailable(t *testing.T) {
	ctx, err := Gather("/bin/sh")
	if err != nil {
		t.Fatalf("Gather failed: %v", err)
	}

	if _, err := exec.LookPath("node"); err == nil {
		if ctx.NodeVersion == "" {
			t.Error("NodeVersion is empty but node is available")
		}
	} else if ctx.NodeVersion != "" {
		t.Errorf("NodeVersion = %q, want empty when node is missing", ctx.NodeVersion)
	}
}

func TestRefreshFromProcessUpdatesWorkingDirectory(t *testing.T) {
	origWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}

	ctx, err := Gather("/bin/sh")
	if err != nil {
		t.Fatalf("Gather failed: %v", err)
	}

	dir := t.TempDir()
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer os.Chdir(origWD)

	if err := ctx.RefreshFromProcess(os.Getpid()); err != nil {
		t.Fatalf("RefreshFromProcess failed: %v", err)
	}

	if ctx.WorkingDirectory != dir {
		t.Errorf("WorkingDirectory = %q, want %q", ctx.WorkingDirectory, dir)
	}
}

func TestShellNameDerivesFromPath(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"/bin/bash", "bash"},
		{"/usr/local/bin/zsh", "zsh"},
		{"fish", "fish"},
		{"/bin/sh", "sh"},
	}

	for _, tt := range tests {
		if got := shellName(tt.path); got != tt.want {
			t.Errorf("shellName(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}
