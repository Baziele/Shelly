// Package staticcontext gathers the always-included Static Context for a
// Session: operating system, User Shell name/version, current working directory,
// and relevant language runtime versions.
package staticcontext

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// StaticContext holds the small, fixed metadata that is always included with
// every LLM request for a Session.
type StaticContext struct {
	OS               string
	Shell            string
	ShellVersion     string
	WorkingDirectory string
	PythonVersion    string
	NodeVersion      string
}

// Gather collects static context for the given shell executable path. The
// current process's working directory is used as the initial working directory.
// Missing language runtimes are reported as empty version strings.
func Gather(shellPath string) (*StaticContext, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("get working directory: %w", err)
	}

	return &StaticContext{
		OS:               runtime.GOOS,
		Shell:            shellName(shellPath),
		ShellVersion:     shellVersion(shellPath),
		WorkingDirectory: cwd,
		PythonVersion:    runtimeVersion("python3", "python"),
		NodeVersion:      runtimeVersion("node"),
	}, nil
}

// RefreshFromProcess updates the WorkingDirectory from the working directory
// of the process identified by pid. On Linux this is read from /proc/<pid>/cwd.
func (s *StaticContext) RefreshFromProcess(pid int) error {
	cwd, err := processCWD(pid)
	if err != nil {
		return fmt.Errorf("refresh working directory: %w", err)
	}
	s.WorkingDirectory = cwd
	return nil
}

func shellName(shellPath string) string {
	return filepath.Base(shellPath)
}

func shellVersion(shellPath string) string {
	out, err := exec.Command(shellPath, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func runtimeVersion(candidates ...string) string {
	for _, candidate := range candidates {
		path, err := exec.LookPath(candidate)
		if err != nil {
			continue
		}
		out, err := exec.Command(path, "--version").Output()
		if err != nil {
			continue
		}
		return strings.TrimSpace(string(out))
	}
	return ""
}

func processCWD(pid int) (string, error) {
	link := fmt.Sprintf("/proc/%d/cwd", pid)
	return os.Readlink(link)
}
