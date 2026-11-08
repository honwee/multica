package handler

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

func TestPluginSurfaceBootstrapConsultsForeignErrorFilterFirst(t *testing.T) {
	document := buildPluginSurfaceDocument("void 0;", "bridge-proof")
	for _, required := range []string{
		"function isForeignSurfaceError(event)",
		"if (failed || isForeignSurfaceError(event)) return;",
	} {
		if !strings.Contains(document, required) {
			t.Fatalf("surface document missing %q", required)
		}
	}
	if strings.Index(document, "function isForeignSurfaceError") > strings.Index(document, `window.addEventListener("error", reportSurfaceError)`) {
		t.Fatal("foreign-error filter defined after the error listeners")
	}
}

// The filter runs in the browser, so its cases run in a JavaScript engine.
// Node is part of the repository toolchain; the structural test above still
// guards the wiring where it is missing.
func TestPluginSurfaceForeignErrorFilterCases(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	surface := "https://plugins.example.com/plugin-surfaces/token"
	metamask := "chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js"
	cases := []struct {
		name    string
		event   map[string]any
		foreign bool
	}{
		{"extension error event", map[string]any{"filename": metamask, "error": map[string]any{"stack": "SecurityError: x"}}, true},
		{"firefox extension error event", map[string]any{"filename": "moz-extension://1234/content.js"}, true},
		{"extension rejection", map[string]any{"reason": map[string]any{"stack": "i: Failed to connect to MetaMask\n    at Object.connect (" + metamask + ":9:6166)"}}, true},
		{"firefox extension rejection", map[string]any{"reason": map[string]any{"stack": "connect@moz-extension://1234/inpage.js:3:7\n"}}, true},
		{"plugin error event", map[string]any{"filename": surface, "error": map[string]any{"stack": "TypeError: boom\n    at render (" + surface + ":1:2)"}}, false},
		{"plugin rejection", map[string]any{"reason": map[string]any{"stack": "Error: 403\n    at port.onmessage (" + surface + ":4:9)"}}, false},
		{"plugin frame above an extension frame", map[string]any{"reason": map[string]any{"stack": "Error: x\n    at render (" + surface + ":1:2)\n    at " + metamask + ":1:1"}}, false},
		{"rejection with a plain value", map[string]any{"reason": "nope"}, false},
		{"rejection without frames", map[string]any{"reason": map[string]any{"stack": "Error: Failed to fetch https://x.test:443"}}, false},
		{"bootstrap catch without event", nil, false},
	}
	events := make([]any, len(cases))
	for index, c := range cases {
		if c.event != nil {
			events[index] = c.event
		}
	}
	encoded, err := json.Marshal(events)
	if err != nil {
		t.Fatal(err)
	}
	script := pluginSurfaceForeignErrorJS + "\nprocess.stdout.write(JSON.stringify(" + string(encoded) + ".map(isForeignSurfaceError)));"
	out, err := exec.Command(node, "-e", script).Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	var got []bool
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("node output %q: %v", out, err)
	}
	for index, c := range cases {
		if got[index] != c.foreign {
			t.Errorf("%s: foreign = %v, want %v", c.name, got[index], c.foreign)
		}
	}
}
