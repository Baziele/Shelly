package tools

import (
	"os/exec"

	"google.golang.org/genai"
)

// ExecuteShell runs a shell command and returns its output.
type ExecuteShell struct{}

func (e *ExecuteShell) Name() string        { return "execute_shell" }
func (e *ExecuteShell) Description() string { return "Execute a shell command and return the stdout, stderr, and exit code." }

func (e *ExecuteShell) Parameters() *genai.Schema {
	return &genai.Schema{
		Type: genai.TypeObject,
		Properties: map[string]*genai.Schema{
			"command": {
				Type:        genai.TypeString,
				Description: "The shell command to execute.",
			},
		},
		Required: []string{"command"},
	}
}

func (e *ExecuteShell) Execute(args map[string]any) (map[string]any, error) {
	cmdStr, err := stringParam(args, "command")
	if err != nil {
		return nil, err
	}
	cmd := exec.Command("sh", "-c", cmdStr)
	out, err := cmd.CombinedOutput()
	exitCode := 0
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	} else if err != nil {
		exitCode = 1
	}
	return map[string]any{
		"stdout":    string(out),
		"stderr":    "",
		"exit_code": exitCode,
	}, nil
}
