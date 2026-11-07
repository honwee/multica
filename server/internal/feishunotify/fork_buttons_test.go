package feishunotify

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/integrations/lark"
)

type fakeButtons struct {
	blocks []CardButtonBlock
	asked  []string
}

func (f *fakeButtons) CardButtons(_ context.Context, workspaceID, issueID, recipientID string) []CardButtonBlock {
	f.asked = append(f.asked, workspaceID+"/"+issueID+"/"+recipientID)
	return f.blocks
}

func sendOneWithButtons(t *testing.T, provider CardButtonProvider) string {
	t.Helper()
	s := &fakeSender{}
	bots := &fakeBots{routes: map[string]lark.AgentBotRoute{
		testAgentID: botRoute(testBotAppID, lark.ReceiveIDTypeOpenID, testBotOpenID),
	}}
	n := newBotNotifier(agentAssigned(testAgentID), s, bots, 20*time.Millisecond)
	if provider != nil {
		n.SetCardButtons(provider)
	}
	process(n, inboxEvent(testIssueID, "new_comment", "hello", nil))
	n.Wait()
	sent := s.sent()
	if len(sent) != 1 {
		t.Fatalf("sent %d, want 1", len(sent))
	}
	return sent[0].CardJSON
}

func TestNotifier_CardUnchangedWithoutButtons(t *testing.T) {
	plain := sendOneWithButtons(t, nil)
	empty := sendOneWithButtons(t, &fakeButtons{})
	if plain != empty {
		t.Fatalf("a provider with no buttons changed the card:\n%s\n%s", plain, empty)
	}
	if strings.Contains(plain, "update_multi") || strings.Contains(plain, `"button"`) {
		t.Fatalf("card without plugin buttons carries button config: %s", plain)
	}
}

func TestNotifier_RendersPluginButtonsWithSignedValues(t *testing.T) {
	provider := &fakeButtons{blocks: []CardButtonBlock{
		{RuleKey: "quick", Buttons: []CardButtonSpec{{Key: "ok", Label: "同意", Style: "primary", Token: "tok-ok"}}},
		{RuleKey: "approval", Input: &CardButtonInputSpec{Placeholder: "修改意见"}, Buttons: []CardButtonSpec{
			{Key: "revise", Label: "修改", Token: "tok-revise"},
			{Key: "reject", Label: "不要", Style: "danger", Token: "tok-reject"},
		}},
	}}
	card := sendOneWithButtons(t, provider)
	if len(provider.asked) != 1 || !strings.Contains(provider.asked[0], testIssueID) {
		t.Fatalf("provider asked %v", provider.asked)
	}
	var decoded struct {
		Config map[string]any `json:"config"`
		Body   struct {
			Elements []map[string]any `json:"elements"`
		} `json:"body"`
	}
	if err := json.Unmarshal([]byte(card), &decoded); err != nil {
		t.Fatalf("card is not JSON: %v", err)
	}
	if decoded.Config["update_multi"] != true {
		t.Fatalf("buttoned card must allow updates: %v", decoded.Config)
	}
	var tags []string
	for _, element := range decoded.Body.Elements {
		tags = append(tags, element["tag"].(string))
	}
	if got := strings.Join(tags, ","); !strings.HasSuffix(got, "markdown,column_set,form") {
		t.Fatalf("element order = %s", got)
	}
	for _, want := range []string{`"multica_card":"tok-ok"`, `"multica_card":"tok-reject"`, `"form_action_type":"submit"`, `"name":"multica_input"`, `"primary_filled"`, `"content":"修改意见"`} {
		if !strings.Contains(card, want) {
			t.Errorf("card lacks %s: %s", want, card)
		}
	}
}

func TestRenderDecisionCard(t *testing.T) {
	card, err := RenderDecisionCard("https://app.example.test/", "lumist", "LUM-7", "[审批] 课表", []string{"已同意 · 张三 · 11-07 15:30", "说明：好"})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{"已同意 · 张三", "说明：好", "https://app.example.test/lumist/issues/LUM-7", `"update_multi":true`} {
		if !strings.Contains(string(card), want) {
			t.Errorf("decision card lacks %q: %s", want, card)
		}
	}
	if strings.Contains(string(card), `"button"`) {
		t.Errorf("decision card must not offer buttons again: %s", card)
	}
}
