package plugincontract

// Fork extension points (see FORK.md): a workspace-level page surface and
// plugin-declared buttons on Feishu notification cards. Both are generic and
// stay inert until a workspace turns them on in
// workspace.settings.plugin_extensions.

import (
	"encoding/json"
	"fmt"
	"strings"
)

// SurfaceWorkspacePage is a full page the host lists in the workspace sidebar.
// It uses the same sandbox, bridge, scopes and CSP as every other surface; it
// is simply not mounted on an issue.
const SurfaceWorkspacePage = "workspace_page"

// TriggerCardAction is a person clicking a plugin-declared button on a Feishu
// notification card. Like ui/manual, the resulting writes belong to that
// person and are marked via_plugin_id.
const TriggerCardAction = "card_action"

// Card button limits. Feishu renders at most a handful of buttons per row; a
// card is a notification, not a form.
const (
	MaxCardButtonRules      = 8
	MaxCardButtonsPerRule   = 5
	MaxCardButtonMatchItems = 32
	MaxCardButtonLabelBytes = 60
)

// Card button styles map onto Feishu button types.
const (
	CardButtonStyleDefault = "default"
	CardButtonStylePrimary = "primary"
	CardButtonStyleDanger  = "danger"
)

// CardButtonRule declares which notification cards carry which buttons, and
// which hook a click invokes.
type CardButtonRule struct {
	Key     string          `json:"key"`
	Hook    string          `json:"hook"`
	Match   CardButtonMatch `json:"match"`
	Buttons []CardButton    `json:"buttons"`
}

// CardButtonMatch selects issues. Fields are ANDed; values inside one field
// are ORed. At least one field must be set, so a rule never decorates every
// notification in a workspace by accident.
type CardButtonMatch struct {
	// Projects matches a project id or exact project title.
	Projects []string `json:"projects,omitempty"`
	// TitlePrefixes matches the start of the issue title.
	TitlePrefixes []string `json:"title_prefixes,omitempty"`
	// Labels matches label names attached to the issue.
	Labels []string `json:"labels,omitempty"`
}

type CardButton struct {
	Key   string           `json:"key"`
	Label string           `json:"label"`
	Style string           `json:"style,omitempty"`
	Input *CardButtonInput `json:"input,omitempty"`
}

// CardButtonInput turns a button into a small form: the card shows a text
// input next to it and the clicker's text is passed to the hook.
type CardButtonInput struct {
	Placeholder string `json:"placeholder,omitempty"`
	Required    bool   `json:"required,omitempty"`
}

// CardIssueFacts is what a rule is matched against.
type CardIssueFacts struct {
	Title        string
	ProjectID    string
	ProjectTitle string
	Labels       []string
}

// Matches reports whether the rule applies to an issue.
func (r CardButtonRule) Matches(issue CardIssueFacts) bool {
	m := r.Match
	if len(m.Projects) == 0 && len(m.TitlePrefixes) == 0 && len(m.Labels) == 0 {
		return false
	}
	if len(m.Projects) > 0 {
		ok := false
		for _, project := range m.Projects {
			if issue.ProjectID != "" && strings.EqualFold(project, issue.ProjectID) {
				ok = true
			}
			if issue.ProjectTitle != "" && project == issue.ProjectTitle {
				ok = true
			}
		}
		if !ok {
			return false
		}
	}
	if len(m.TitlePrefixes) > 0 {
		ok := false
		for _, prefix := range m.TitlePrefixes {
			if strings.HasPrefix(issue.Title, prefix) {
				ok = true
			}
		}
		if !ok {
			return false
		}
	}
	if len(m.Labels) > 0 {
		ok := false
		for _, want := range m.Labels {
			for _, have := range issue.Labels {
				if want == have {
					ok = true
				}
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

// Button returns the named button of a rule.
func (r CardButtonRule) Button(key string) (CardButton, bool) {
	for _, button := range r.Buttons {
		if button.Key == key {
			return button, true
		}
	}
	return CardButton{}, false
}

// CardButtonRule returns the named rule of a manifest.
func (m Manifest) CardButtonRule(key string) (CardButtonRule, bool) {
	for _, rule := range m.Contributes.CardButtons {
		if rule.Key == key {
			return rule, true
		}
	}
	return CardButtonRule{}, false
}

// CardActionResponse is what a card_action hook answers. The host performs the
// effects as the person who clicked, then shows StatusText on the card.
type CardActionResponse struct {
	Effects    []CardActionEffect `json:"effects,omitempty"`
	StatusText string             `json:"status_text,omitempty"`
}

// Card action effect types.
const (
	CardEffectComment   = "comment"
	CardEffectSetStatus = "set_status"
)

// MaxCardActionEffects bounds how much one click may do.
const MaxCardActionEffects = 5

type CardActionEffect struct {
	Type    string `json:"type"`
	Content string `json:"content,omitempty"`
	Status  string `json:"status,omitempty"`
}

// ParseCardActionResponse decodes a hook's answer. An empty body means "do
// nothing", which is a valid answer.
func ParseCardActionResponse(raw json.RawMessage) (CardActionResponse, error) {
	var out CardActionResponse
	if len(strings.TrimSpace(string(raw))) == 0 || string(raw) == "null" {
		return out, nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return CardActionResponse{}, fmt.Errorf("card action response must be an object: %w", err)
	}
	if len(out.Effects) > MaxCardActionEffects {
		return CardActionResponse{}, fmt.Errorf("card action response must not exceed %d effects", MaxCardActionEffects)
	}
	for index, effect := range out.Effects {
		switch effect.Type {
		case CardEffectComment:
			if strings.TrimSpace(effect.Content) == "" {
				return CardActionResponse{}, fmt.Errorf("effects[%d].content must not be empty", index)
			}
		case CardEffectSetStatus:
			if strings.TrimSpace(effect.Status) == "" {
				return CardActionResponse{}, fmt.Errorf("effects[%d].status must not be empty", index)
			}
		default:
			return CardActionResponse{}, fmt.Errorf("effects[%d].type is unsupported: %q", index, effect.Type)
		}
	}
	if len(out.StatusText) > 200 {
		return CardActionResponse{}, fmt.Errorf("status_text exceeds 200 bytes")
	}
	return out, nil
}

func (m Manifest) validateCardButtons() error {
	rules := m.Contributes.CardButtons
	if len(rules) == 0 {
		return nil
	}
	if len(rules) > MaxCardButtonRules {
		return fmt.Errorf("contributes.card_buttons must not exceed %d entries", MaxCardButtonRules)
	}
	// The hook is handed the issue the card is about.
	if !hasScope(m.Scopes, ScopeIssuesRead) {
		return fmt.Errorf("contributes.card_buttons requires the %s scope", ScopeIssuesRead)
	}
	hooks := map[string]Hook{}
	for _, hook := range m.Contributes.Hooks {
		hooks[hook.Key] = hook
	}
	ruleKeys := map[string]bool{}
	for index, rule := range rules {
		field := fmt.Sprintf("contributes.card_buttons[%d]", index)
		if !contributionKeyPattern.MatchString(rule.Key) || len(rule.Key) > 64 {
			return fmt.Errorf("%s.key is invalid", field)
		}
		if ruleKeys[rule.Key] {
			return fmt.Errorf("duplicate card button rule key %q", rule.Key)
		}
		ruleKeys[rule.Key] = true
		hook, ok := hooks[rule.Hook]
		if !ok {
			return fmt.Errorf("%s.hook names no declared hook: %q", field, rule.Hook)
		}
		if !hasScope(hook.Triggers, TriggerCardAction) {
			return fmt.Errorf("%s.hook %q must declare the %s trigger", field, rule.Hook, TriggerCardAction)
		}
		if hook.Transport.Type != TransportHTTP {
			return fmt.Errorf("%s.hook %q must use the http transport", field, rule.Hook)
		}
		match := rule.Match
		if len(match.Projects) == 0 && len(match.TitlePrefixes) == 0 && len(match.Labels) == 0 {
			return fmt.Errorf("%s.match must set at least one of projects, title_prefixes or labels", field)
		}
		for name, values := range map[string][]string{
			"projects": match.Projects, "title_prefixes": match.TitlePrefixes, "labels": match.Labels,
		} {
			if len(values) > MaxCardButtonMatchItems {
				return fmt.Errorf("%s.match.%s must not exceed %d entries", field, name, MaxCardButtonMatchItems)
			}
			for _, value := range values {
				if err := validateDisplayText(field+".match."+name, value, 160); err != nil {
					return err
				}
			}
		}
		if len(rule.Buttons) == 0 || len(rule.Buttons) > MaxCardButtonsPerRule {
			return fmt.Errorf("%s.buttons must have between 1 and %d entries", field, MaxCardButtonsPerRule)
		}
		buttonKeys := map[string]bool{}
		for buttonIndex, button := range rule.Buttons {
			buttonField := fmt.Sprintf("%s.buttons[%d]", field, buttonIndex)
			if !contributionKeyPattern.MatchString(button.Key) || len(button.Key) > 64 {
				return fmt.Errorf("%s.key is invalid", buttonField)
			}
			if buttonKeys[button.Key] {
				return fmt.Errorf("%s.key is duplicated: %q", buttonField, button.Key)
			}
			buttonKeys[button.Key] = true
			if err := validateDisplayText(buttonField+".label", button.Label, MaxCardButtonLabelBytes); err != nil {
				return err
			}
			switch button.Style {
			case "", CardButtonStyleDefault, CardButtonStylePrimary, CardButtonStyleDanger:
			default:
				return fmt.Errorf("%s.style is unsupported: %q", buttonField, button.Style)
			}
			if button.Input != nil && len(button.Input.Placeholder) > 160 {
				return fmt.Errorf("%s.input.placeholder exceeds 160 bytes", buttonField)
			}
		}
	}
	return nil
}
