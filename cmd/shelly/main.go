package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/baziele/shelly/internal/llm"
	"github.com/baziele/shelly/internal/quickrequest"
	"github.com/baziele/shelly/internal/session"
)

func main() {
	staticContextFlag := flag.Bool("static-context", false, "Print the gathered static context as JSON and exit")
	flag.Parse()

	s, err := session.New(os.Getenv("SHELL"))
	if err != nil {
		os.Exit(1)
	}

	// Wire up Quick Request handler.
	adapter := llm.NewOpenAIAdapter()
	s.QuickRequestHandler = &quickrequest.Handler{
		LLM:           adapter,
		StaticContext: s.StaticContext(),
		History:       s.CommandHistory(),
	}

	if *staticContextFlag {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(s.StaticContext()); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	if err := s.Run(); err != nil {
		os.Exit(1)
	}

	if dumpPath := os.Getenv("SHELLY_CONTEXT_DUMP"); dumpPath != "" {
		var w io.Writer = os.Stdout
		if dumpPath != "-" {
			f, err := os.Create(dumpPath)
			if err != nil {
				fmt.Fprintf(os.Stderr, "shelly: cannot create context dump: %v\n", err)
				os.Exit(1)
			}
			defer f.Close()
			w = f
		}
		if err := s.DumpContext(w); err != nil {
			fmt.Fprintf(os.Stderr, "shelly: cannot dump context: %v\n", err)
			os.Exit(1)
		}
	}
}
