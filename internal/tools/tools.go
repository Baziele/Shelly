// Package tools provides local environment tools for the Agent Mode agent.
package tools

import (
	"encoding/json"
	"fmt"

	"google.golang.org/genai"
)

// Tool is a capability exposed to the LLM agent.
type Tool interface {
	// Name returns the function name used in the LLM function call.
	Name() string
	// Description returns the function description shown to the LLM.
	Description() string
	// Parameters returns the JSON schema describing the function arguments.
	Parameters() *genai.Schema
	// Execute runs the tool with the given arguments and returns the result.
	Execute(args map[string]any) (map[string]any, error)
}

// Registry holds all available tools.
type Registry struct {
	tools map[string]Tool
}

// NewRegistry creates a registry pre-loaded with the standard Shelly tools.
func NewRegistry() *Registry {
	r := &Registry{tools: make(map[string]Tool)}
	r.Add(&ReadFile{})
	r.Add(&ExecuteShell{})
	r.Add(&EditFile{})
	r.Add(&SearchOnline{})
	return r
}

// Add registers a tool.
func (r *Registry) Add(t Tool) {
	r.tools[t.Name()] = t
}

// Get looks up a tool by name.
func (r *Registry) Get(name string) (Tool, bool) {
	t, ok := r.tools[name]
	return t, ok
}

// All returns every registered tool.
func (r *Registry) All() []Tool {
	out := make([]Tool, 0, len(r.tools))
	for _, t := range r.tools {
		out = append(out, t)
	}
	return out
}

// GenaiTools converts the registry to a slice of genai.Tool for the LLM.
func (r *Registry) GenaiTools() []*genai.Tool {
	all := r.All()
	decls := make([]*genai.FunctionDeclaration, 0, len(all))
	for _, t := range all {
		decls = append(decls, &genai.FunctionDeclaration{
			Name:        t.Name(),
			Description: t.Description(),
			Parameters:  t.Parameters(),
		})
	}
	return []*genai.Tool{{FunctionDeclarations: decls}}
}

// Run looks up a tool by name and executes it with the provided arguments.
func (r *Registry) Run(name string, args map[string]any) (map[string]any, error) {
	t, ok := r.Get(name)
	if !ok {
		return nil, fmt.Errorf("unknown tool: %s", name)
	}
	return t.Execute(args)
}

// stringParam extracts a required string parameter from args.
func stringParam(args map[string]any, key string) (string, error) {
	v, ok := args[key]
	if !ok {
		return "", fmt.Errorf("missing required parameter %q", key)
	}
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("parameter %q must be a string", key)
	}
	return s, nil
}

// optionalStringParam extracts an optional string parameter.
func optionalStringParam(args map[string]any, key string) string {
	v, ok := args[key]
	if !ok {
		return ""
	}
	s, _ := v.(string)
	return s
}

// toJSON marshals a value to a JSON string, falling back to fmt.Sprintf.
func toJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}
