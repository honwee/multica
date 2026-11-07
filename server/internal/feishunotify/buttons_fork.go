package feishunotify

// Fork extension point (see FORK.md): plugin-declared buttons on notification
// cards. The notifier only renders what a CardButtonProvider returns; which
// issues get which buttons, and what a click does, is decided by workspace
// plugins and handled in handler/plugin_card_action_fork.go. With no provider,
// or a provider that returns nothing, cards are unchanged.

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"sync"
)

// CardActionValueKey is the key of the signed token in a button's callback
// value; CardActionInputName is the name of the form input.
const (
	CardActionValueKey  = "multica_card"
	CardActionInputName = "multica_input"
)

// CardButtonBlock is one plugin rule's buttons on one card.
type CardButtonBlock struct {
	RuleKey string
	// Input, when set, renders a text input submitted with the buttons.
	Input   *CardButtonInputSpec
	Buttons []CardButtonSpec
}

type CardButtonInputSpec struct {
	Placeholder string
}

type CardButtonSpec struct {
	Key   string
	Label string
	// Style is default, primary or danger.
	Style string
	// Token is the signed callback value that identifies this click.
	Token string
}

// CardButtonProvider returns the buttons for a recipient's card about an
// issue. It must be fast and must not fail the notification: errors are its
// own to log, and the answer is then no buttons.
type CardButtonProvider interface {
	CardButtons(ctx context.Context, workspaceID, issueID, recipientID string) []CardButtonBlock
}

type buttonProviderSlot struct {
	mu       sync.RWMutex
	provider CardButtonProvider
}

// SetCardButtons installs the provider. The handler that implements it is
// built after the notifier, so it is set rather than passed to New.
func (n *Notifier) SetCardButtons(p CardButtonProvider) {
	n.buttons.mu.Lock()
	defer n.buttons.mu.Unlock()
	n.buttons.provider = p
}

func (n *Notifier) cardButtonElements(ctx context.Context, ev event) []any {
	n.buttons.mu.RLock()
	provider := n.buttons.provider
	n.buttons.mu.RUnlock()
	if provider == nil {
		return nil
	}
	return CardButtonElements(provider.CardButtons(ctx, ev.WorkspaceID, ev.IssueID, ev.RecipientID))
}

// CardButtonElements renders button blocks as schema 2.0 card elements.
func CardButtonElements(blocks []CardButtonBlock) []any {
	var elements []any
	for _, block := range blocks {
		if len(block.Buttons) == 0 {
			continue
		}
		submit := block.Input != nil
		columns := make([]any, 0, len(block.Buttons))
		for _, button := range block.Buttons {
			element := map[string]any{
				"tag":  "button",
				"text": map[string]any{"tag": "plain_text", "content": button.Label},
				"type": buttonType(button.Style),
				"behaviors": []any{map[string]any{
					"type":  "callback",
					"value": map[string]any{CardActionValueKey: button.Token},
				}},
			}
			if submit {
				element["name"] = "multica_btn_" + button.Key
				element["form_action_type"] = "submit"
			}
			columns = append(columns, map[string]any{
				"tag":      "column",
				"width":    "auto",
				"elements": []any{element},
			})
		}
		row := map[string]any{
			"tag":                "column_set",
			"flex_mode":          "flow",
			"horizontal_spacing": "small",
			"columns":            columns,
		}
		if !submit {
			elements = append(elements, row)
			continue
		}
		input := map[string]any{
			"tag":  "input",
			"name": CardActionInputName,
		}
		if block.Input.Placeholder != "" {
			input["placeholder"] = map[string]any{"tag": "plain_text", "content": block.Input.Placeholder}
		}
		elements = append(elements, map[string]any{
			"tag":      "form",
			"name":     "multica_form_" + block.RuleKey,
			"elements": []any{input, row},
		})
	}
	return elements
}

func buttonType(style string) string {
	switch style {
	case "primary":
		return "primary_filled"
	case "danger":
		return "danger"
	}
	return "default"
}

// RenderDecisionCard is the card that replaces a notification after a button
// was handled: the issue, what was decided and by whom, and the link.
func RenderDecisionCard(appURL, workspaceSlug, identifier, title string, lines []string) (json.RawMessage, error) {
	header := strings.TrimSpace(identifier + " " + title)
	elements := []any{}
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			elements = append(elements, plainDiv(line))
		}
	}
	base := strings.TrimRight(appURL, "/")
	if base != "" && workspaceSlug != "" && identifier != "" {
		elements = append(elements, map[string]any{
			"tag":     "markdown",
			"content": "[在 Multica 中查看](" + base + "/" + url.PathEscape(workspaceSlug) + "/issues/" + url.PathEscape(identifier) + ")",
		})
	}
	card := map[string]any{
		"schema": "2.0",
		"config": map[string]any{"update_multi": true},
		"header": map[string]any{
			"title":    map[string]any{"tag": "plain_text", "content": CardTitle},
			"subtitle": map[string]any{"tag": "plain_text", "content": truncateRunes(header, 120)},
			"template": "green",
		},
		"body": map[string]any{"elements": elements},
	}
	out, err := json.Marshal(card)
	if err != nil {
		return nil, err
	}
	return out, nil
}
