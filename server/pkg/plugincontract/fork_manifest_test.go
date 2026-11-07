package plugincontract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const forkTestManifest = `{
  "manifest_version": 1,
  "key": "com.example.review",
  "name": "Review",
  "version": "1.0.0",
  "author": { "name": "example" },
  "scopes": ["issues:read", "issues:write", "comments:write", "net:review.example.com"],
  "contributes": {
    "surfaces": [{ "key": "board", "type": "workspace_page", "name": "Board", "entry": "ui/main.js" }],
    "hooks": [{
      "key": "decide",
      "name": "Decide",
      "description": "Records a decision made from a notification card.",
      "triggers": ["card_action"],
      "transport": { "type": "http", "url": "https://review.example.com/hooks/decide" }
    }],
    "card_buttons": [{
      "key": "approval",
      "hook": "decide",
      "match": { "title_prefixes": ["[审批]"], "projects": ["教务"], "labels": ["需审批"] },
      "buttons": [
        { "key": "approve", "label": "同意", "style": "primary" },
        { "key": "revise", "label": "修改", "input": { "placeholder": "修改意见", "required": true } },
        { "key": "reject", "label": "不要", "style": "danger" }
      ]
    }]
  }
}`

func TestForkManifestAcceptsWorkspacePageAndCardButtons(t *testing.T) {
	manifest, canonical, err := ParseManifest([]byte(forkTestManifest))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	if err := manifest.CheckCapabilities(HostCapabilities()); err != nil {
		t.Fatalf("host refuses its own fork capabilities: %v", err)
	}
	// The canonical snapshot an installation stores must keep the rules.
	if !strings.Contains(string(canonical), `"card_buttons"`) {
		t.Fatalf("canonical manifest dropped card_buttons: %s", canonical)
	}
	rule, ok := manifest.CardButtonRule("approval")
	if !ok || len(rule.Buttons) != 3 {
		t.Fatalf("rule = %+v ok=%v", rule, ok)
	}
	if button, ok := rule.Button("revise"); !ok || button.Input == nil || !button.Input.Required {
		t.Fatalf("revise button = %+v", button)
	}
}

func TestForkManifestRejectsInvalidCardButtons(t *testing.T) {
	cases := map[string]struct {
		old, new string
		want     string
	}{
		"hook without card_action trigger": {`"triggers": ["card_action"]`, `"triggers": ["manual"]`, "must declare the card_action trigger"},
		"unknown hook":                     {`"hook": "decide"`, `"hook": "missing"`, "names no declared hook"},
		"empty match":                      {`"match": { "title_prefixes": ["[审批]"], "projects": ["教务"], "labels": ["需审批"] }`, `"match": {}`, "match must set"},
		"unknown rule field":               {`"buttons": [`, `"unused": 1, "buttons": [`, "unknown field"},
		"bad style":                        {`"style": "danger"`, `"style": "red"`, "style is unsupported"},
		"missing issues:read":              {`"scopes": ["issues:read", `, `"scopes": [`, "requires the issues:read scope"},
		"duplicate button":                 {`"key": "reject"`, `"key": "approve"`, "duplicated"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			raw := strings.Replace(forkTestManifest, tc.old, tc.new, 1)
			if raw == forkTestManifest {
				t.Fatalf("replacement %q did not apply", tc.old)
			}
			_, _, err := ParseManifest([]byte(raw))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want containing %q", err, tc.want)
			}
		})
	}
}

func TestCardButtonRuleMatching(t *testing.T) {
	rule := CardButtonRule{Match: CardButtonMatch{
		Projects:      []string{"教务", "0190e3a2-0000-7000-8000-000000000001"},
		TitlePrefixes: []string{"[审批]", "[请假]"},
		Labels:        []string{"需审批"},
	}}
	base := CardIssueFacts{Title: "[审批] 课表调整", ProjectTitle: "教务", Labels: []string{"其他", "需审批"}}
	if !rule.Matches(base) {
		t.Fatal("all criteria satisfied, rule did not match")
	}
	byID := base
	byID.ProjectTitle = ""
	byID.ProjectID = "0190E3A2-0000-7000-8000-000000000001"
	if !rule.Matches(byID) {
		t.Fatal("project id match is case-insensitive")
	}
	for name, facts := range map[string]CardIssueFacts{
		"wrong prefix":  {Title: "课表调整", ProjectTitle: "教务", Labels: []string{"需审批"}},
		"wrong project": {Title: "[审批] x", ProjectTitle: "运营", Labels: []string{"需审批"}},
		"no label":      {Title: "[审批] x", ProjectTitle: "教务"},
	} {
		if rule.Matches(facts) {
			t.Fatalf("%s: rule matched", name)
		}
	}
	if (CardButtonRule{}).Matches(base) {
		t.Fatal("a rule with no criteria must never match")
	}
}

func TestParseCardActionResponse(t *testing.T) {
	got, err := ParseCardActionResponse(json.RawMessage(`{"effects":[{"type":"comment","content":"同意"},{"type":"set_status","status":"done"}],"status_text":"已同意"}`))
	if err != nil || len(got.Effects) != 2 || got.StatusText != "已同意" {
		t.Fatalf("got %+v err=%v", got, err)
	}
	if empty, err := ParseCardActionResponse(nil); err != nil || len(empty.Effects) != 0 {
		t.Fatalf("empty response: %+v err=%v", empty, err)
	}
	for _, raw := range []string{
		`{"effects":[{"type":"delete_issue"}]}`,
		`{"effects":[{"type":"comment","content":"  "}]}`,
		`{"effects":[{"type":"set_status"}]}`,
		`[1,2]`,
	} {
		if _, err := ParseCardActionResponse(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}

// The example a plugin author copies must stay installable on this host.
func TestForkExampleManifestIsValid(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "examples", "plugins", "workspace-review", ManifestFilename))
	if err != nil {
		t.Fatalf("read example manifest: %v", err)
	}
	manifest, _, err := ParseManifest(raw)
	if err != nil {
		t.Fatalf("example manifest: %v", err)
	}
	if err := manifest.CheckCapabilities(HostCapabilities()); err != nil {
		t.Fatalf("example manifest needs capabilities this host lacks: %v", err)
	}
	if len(manifest.Contributes.CardButtons) == 0 || manifest.Contributes.Surfaces[0].Type != SurfaceWorkspacePage {
		t.Fatalf("example no longer demonstrates both extension points: %+v", manifest.Contributes)
	}
}
