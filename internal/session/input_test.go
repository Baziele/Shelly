package session

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestInputProxyDetectsQuickRequest(t *testing.T) {
	var handlerCalled bool
	var handlerQuestion string

	handler := func(question string) (string, error) {
		handlerCalled = true
		handlerQuestion = question
		return "Hello, user!", nil
	}

	stdin := strings.NewReader(": hello\n")
	pty := &bytes.Buffer{}
	stdout := &bytes.Buffer{}

	proxy := &inputProxy{
		stdin:   stdin,
		pty:     pty,
		stdout:  stdout,
		handler: handler,
	}

	done := make(chan struct{})
	go func() {
		proxy.run()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("proxy did not finish")
	}

	if !handlerCalled {
		t.Fatal("handler was not called")
	}
	if handlerQuestion != "hello" {
		t.Errorf("question = %q, want %q", handlerQuestion, "hello")
	}

	// The response should be rendered to stdout before the shell sees Enter.
	out := stdout.String()
	if !strings.Contains(out, "\nHello, user!") {
		t.Errorf("stdout does not contain response on its own line, got: %q", out)
	}

	// The quick request line should be forwarded to the PTY unchanged, and the
	// Enter should arrive after the response is printed.
	ptyOut := pty.String()
	if ptyOut != ": hello\n" {
		t.Errorf("pty = %q, want %q", ptyOut, ": hello\n")
	}
}

func TestInputProxyForwardsNormalInput(t *testing.T) {
	stdin := strings.NewReader("echo hello\n")
	pty := &bytes.Buffer{}
	stdout := &bytes.Buffer{}

	proxy := &inputProxy{
		stdin:   stdin,
		pty:     pty,
		stdout:  stdout,
		handler: func(string) (string, error) { return "", nil },
	}

	done := make(chan struct{})
	go func() {
		proxy.run()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("proxy did not finish")
	}

	if pty.String() != "echo hello\n" {
		t.Errorf("pty = %q, want %q", pty.String(), "echo hello\n")
	}
}

func TestInputProxyDoesNotTriggerOnColonWithoutSpace(t *testing.T) {
	var handlerCalled bool

	stdin := strings.NewReader(":what\n")
	pty := &bytes.Buffer{}
	stdout := &bytes.Buffer{}

	proxy := &inputProxy{
		stdin:   stdin,
		pty:     pty,
		stdout:  stdout,
		handler: func(string) (string, error) { handlerCalled = true; return "", nil },
	}

	done := make(chan struct{})
	go func() {
		proxy.run()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("proxy did not finish")
	}

	if handlerCalled {
		t.Fatal("handler should not be called for ':what'")
	}
	if pty.String() != ":what\n" {
		t.Errorf("pty = %q, want %q", pty.String(), ":what\n")
	}
}
