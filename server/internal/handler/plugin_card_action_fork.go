package handler

// Fork extension point (see FORK.md): plugin-declared buttons on Feishu
// notification cards.
//
// Rendering: the Feishu notifier asks PluginCardActions.CardButtons for the
// buttons of each card. A plugin's card_buttons rules match the issue, and
// each button carries a signed token naming the workspace, installation,
// issue, rule and button.
//
// Clicking: the agent bot's long connection delivers card.action.trigger to
// PluginCardActions.HandleCardAction, which must answer inside Lark's ACK
// budget. It verifies the token, maps the clicker's Feishu identity on that
// bot to a Multica member with access to the issue, claims the card so the
// decision runs once, invokes the plugin's card_action hook as the clicker,
// performs the effects the hook returns as the clicker (marked
// via_plugin_id), and replaces the card with the decision.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/feishunotify"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/plugincontract"
)

const (
	// pluginCardTokenMaxAge bounds how long a notification's buttons work.
	pluginCardTokenMaxAge = 14 * 24 * time.Hour
	// pluginCardClaimStale lets a click retry a decision whose previous
	// attempt never finished (process restart mid-call).
	pluginCardClaimStale = 30 * time.Second
	// pluginCardHookTimeout caps the hook call so the effects and the ACK
	// still fit Lark's three second callback budget.
	pluginCardHookTimeout = 1500 * time.Millisecond
	// pluginCardEffectTimeout bounds the effects. They run detached from the
	// callback deadline so a decision is never half applied.
	pluginCardEffectTimeout = 5 * time.Second
)

// PluginCardActions implements feishunotify.CardButtonProvider and
// lark.CardActionHandler over the handler.
type PluginCardActions struct {
	h      *Handler
	now    func() time.Time
	logger *slog.Logger
}

// PluginCardActions returns the card button bridge for this handler.
func (h *Handler) PluginCardActions() *PluginCardActions {
	return &PluginCardActions{h: h, now: time.Now, logger: slog.Default()}
}

var (
	_ feishunotify.CardButtonProvider = (*PluginCardActions)(nil)
	_ lark.CardActionHandler          = (*PluginCardActions)(nil)
)

// pluginCardClaims is what a button token names. Short keys keep the card
// payload small.
type pluginCardClaims struct {
	Version        int    `json:"v"`
	WorkspaceID    string `json:"w"`
	InstallationID string `json:"p"`
	IssueID        string `json:"i"`
	RuleKey        string `json:"r"`
	ButtonKey      string `json:"b"`
	IssuedAt       int64  `json:"t"`
}

var errPluginCardToken = errors.New("invalid plugin card token")

func (c *PluginCardActions) signingKey() ([]byte, bool) {
	key := c.h.PluginService.DeploymentKey
	if len(key) != 32 {
		return nil, false
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("multica/plugin-card-action/v1"))
	return mac.Sum(nil), true
}

func (c *PluginCardActions) signToken(claims pluginCardClaims) (string, error) {
	key, ok := c.signingKey()
	if !ok {
		return "", errors.New("plugin deployment key is not configured")
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (c *PluginCardActions) verifyToken(token string) (pluginCardClaims, error) {
	key, ok := c.signingKey()
	if !ok {
		return pluginCardClaims{}, errPluginCardToken
	}
	encoded, signature, found := strings.Cut(token, ".")
	if !found {
		return pluginCardClaims{}, errPluginCardToken
	}
	presented, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return pluginCardClaims{}, errPluginCardToken
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(encoded))
	if !hmac.Equal(presented, mac.Sum(nil)) {
		return pluginCardClaims{}, errPluginCardToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return pluginCardClaims{}, errPluginCardToken
	}
	var claims pluginCardClaims
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Version != 1 {
		return pluginCardClaims{}, errPluginCardToken
	}
	age := c.now().Sub(time.Unix(claims.IssuedAt, 0))
	if age < -time.Minute || age > pluginCardTokenMaxAge {
		return pluginCardClaims{}, errPluginCardToken
	}
	return claims, nil
}

// CardButtons implements feishunotify.CardButtonProvider.
func (c *PluginCardActions) CardButtons(ctx context.Context, workspaceID, issueID, _ string) []feishunotify.CardButtonBlock {
	if _, ok := c.signingKey(); !ok {
		return nil
	}
	wsID, err := util.ParseUUID(workspaceID)
	if err != nil {
		return nil
	}
	if !c.h.workspacePluginExtensions(ctx, wsID).CardButtons {
		return nil
	}
	iID, err := util.ParseUUID(issueID)
	if err != nil {
		return nil
	}
	installations, err := c.h.Queries.ListWorkspacePluginInstallations(ctx, wsID)
	if err != nil {
		c.logger.Warn("plugin card buttons: list installations failed", "workspace_id", workspaceID, "error", err)
		return nil
	}
	var facts *plugincontract.CardIssueFacts
	var blocks []feishunotify.CardButtonBlock
	for _, installation := range installations {
		if !installation.Enabled {
			continue
		}
		manifest, err := service.ParseInstallationManifest(installation)
		if err != nil || len(manifest.Contributes.CardButtons) == 0 {
			continue
		}
		if facts == nil {
			loaded, ok := c.issueFacts(ctx, wsID, iID)
			if !ok {
				return nil
			}
			facts = &loaded
		}
		for _, rule := range manifest.Contributes.CardButtons {
			if !rule.Matches(*facts) {
				continue
			}
			block := feishunotify.CardButtonBlock{RuleKey: rule.Key}
			issuedAt := c.now().Unix()
			for _, button := range rule.Buttons {
				token, err := c.signToken(pluginCardClaims{
					Version:        1,
					WorkspaceID:    workspaceID,
					InstallationID: uuidToString(installation.ID),
					IssueID:        issueID,
					RuleKey:        rule.Key,
					ButtonKey:      button.Key,
					IssuedAt:       issuedAt,
				})
				if err != nil {
					return nil
				}
				block.Buttons = append(block.Buttons, feishunotify.CardButtonSpec{
					Key: button.Key, Label: button.Label, Style: button.Style, Token: token,
				})
				if button.Input != nil && block.Input == nil {
					block.Input = &feishunotify.CardButtonInputSpec{Placeholder: button.Input.Placeholder}
				}
			}
			blocks = append(blocks, block)
		}
	}
	return blocks
}

func (c *PluginCardActions) issueFacts(ctx context.Context, workspaceID, issueID pgtype.UUID) (plugincontract.CardIssueFacts, bool) {
	issue, err := c.h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspaceID})
	if err != nil {
		return plugincontract.CardIssueFacts{}, false
	}
	facts := plugincontract.CardIssueFacts{Title: issue.Title}
	if issue.ProjectID.Valid {
		facts.ProjectID = uuidToString(issue.ProjectID)
		if project, err := c.h.Queries.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: issue.ProjectID, WorkspaceID: workspaceID}); err == nil {
			facts.ProjectTitle = project.Title
		}
	}
	if labels, err := c.h.Queries.ListLabelsByIssue(ctx, db.ListLabelsByIssueParams{IssueID: issueID, WorkspaceID: workspaceID}); err == nil {
		for _, label := range labels {
			facts.Labels = append(facts.Labels, label.Name)
		}
	}
	return facts, true
}

func cardToast(kind, content string) *lark.CardActionReply {
	return &lark.CardActionReply{Toast: &lark.CardToast{Type: kind, Content: content}}
}

// HandleCardAction implements lark.CardActionHandler.
func (c *PluginCardActions) HandleCardAction(ctx context.Context, inst lark.Installation, event lark.CardActionEvent) *lark.CardActionReply {
	token, _ := event.Value[feishunotify.CardActionValueKey].(string)
	if token == "" {
		// Not a plugin button. Card callbacks were ACKed without an answer
		// before this extension point existed; keep doing that.
		return nil
	}
	claims, err := c.verifyToken(token)
	if err != nil {
		return cardToast(lark.CardToastWarning, "按钮已失效，请在 Multica 中操作")
	}
	workspaceID, err := util.ParseUUID(claims.WorkspaceID)
	if err != nil || uuidToString(inst.WorkspaceID) != claims.WorkspaceID {
		return cardToast(lark.CardToastError, "按钮与当前机器人不匹配")
	}
	if !c.h.workspacePluginExtensions(ctx, workspaceID).CardButtons {
		return cardToast(lark.CardToastWarning, "该工作区已关闭卡片按钮")
	}

	installation, rule, button, hook, refusal := c.resolveContribution(ctx, workspaceID, claims)
	if refusal != "" {
		return cardToast(lark.CardToastWarning, refusal)
	}

	user, ok := c.resolveClicker(ctx, inst, event)
	if !ok {
		return cardToast(lark.CardToastError, "无法识别你的 Multica 账号。请先给这个机器人发一条消息完成绑定")
	}
	member, err := c.h.getWorkspaceMember(ctx, uuidToString(user.ID), claims.WorkspaceID)
	if err != nil {
		return cardToast(lark.CardToastError, "你不是该工作区的成员，无权操作")
	}
	issueID, _ := util.ParseUUID(claims.IssueID)
	issue, err := c.h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: workspaceID})
	if err != nil {
		return cardToast(lark.CardToastError, "Issue 不存在或你无权访问")
	}

	input := strings.TrimSpace(event.InputValue)
	if value, ok := event.FormValue[feishunotify.CardActionInputName].(string); ok {
		input = strings.TrimSpace(value)
	}
	if button.Input != nil && button.Input.Required && input == "" {
		return cardToast(lark.CardToastWarning, "请先填写内容，再点「"+button.Label+"」")
	}
	if len(input) > maxCommentContentBytes {
		return cardToast(lark.CardToastWarning, "内容过长")
	}

	claim, err := c.h.Queries.ClaimPluginCardAction(ctx, db.ClaimPluginCardActionParams{
		WorkspaceID:    workspaceID,
		InstallationID: installation.ID,
		IssueID:        issue.ID,
		MessageID:      event.MessageID,
		RuleKey:        rule.Key,
		ButtonKey:      button.Key,
		UserID:         user.ID,
		StaleBefore:    pgtype.Timestamptz{Time: c.now().Add(-pluginCardClaimStale), Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return c.alreadyClaimed(ctx, workspaceID, issue, event.MessageID, rule.Key)
	}
	if err != nil {
		c.logger.Warn("plugin card action: claim failed", "error", err)
		return cardToast(lark.CardToastError, "处理失败，请稍后重试")
	}

	caller := service.PluginActionCaller{
		Installation: installation,
		WorkspaceID:  workspaceID,
		UserID:       user.ID,
		Scopes:       decodeGrantedScopes(installation.GrantedScopes),
		IssueScope:   issue.ID,
	}
	hook.TimeoutMs = cardHookTimeoutMs(hook.TimeoutMs)
	hookCtx, cancel := context.WithTimeout(ctx, pluginCardHookTimeout+200*time.Millisecond)
	result, err := c.h.PluginService.InvokeHook(hookCtx, service.HookInvocation{
		Installation: installation,
		Hook:         hook,
		Trigger:      plugincontract.TriggerCardAction,
		Actor:        service.HookActor{Type: "member", ID: user.ID},
		IssueID:      issue.ID,
		Input: map[string]any{
			"rule":       rule.Key,
			"button":     button.Key,
			"input":      input,
			"message_id": event.MessageID,
		},
	}, 1)
	cancel()
	if err != nil {
		timedOut := result.Status == "timeout" || errors.Is(err, context.DeadlineExceeded)
		c.finish(claim.ID, "failed", "", hookErrorText(result, err))
		if timedOut {
			return cardToast(lark.CardToastError, "插件响应超时，请重试")
		}
		return cardToast(lark.CardToastError, "插件处理失败，请重试")
	}
	response, err := plugincontract.ParseCardActionResponse(result.Output)
	if err != nil {
		c.finish(claim.ID, "failed", "", err.Error())
		return cardToast(lark.CardToastError, "插件返回的结果无效")
	}

	effectCtx, cancelEffects := context.WithTimeout(context.WithoutCancel(ctx), pluginCardEffectTimeout)
	failures := c.applyEffects(effectCtx, caller, member.UserID, issue, response.Effects)
	cancelEffects()

	statusText := strings.TrimSpace(response.StatusText)
	if statusText == "" {
		statusText = button.Label
	}
	line := fmt.Sprintf("%s · %s · %s", statusText, displayName(user), c.now().In(cardTimeZone()).Format("01-02 15:04"))
	c.finish(claim.ID, "done", line, strings.Join(failures, "; "))

	reply := &lark.CardActionReply{Toast: &lark.CardToast{Type: lark.CardToastSuccess, Content: statusText}}
	if len(failures) > 0 {
		reply.Toast = &lark.CardToast{Type: lark.CardToastWarning, Content: "部分操作未完成：" + strings.Join(failures, "；")}
	}
	lines := []string{line}
	if input != "" {
		lines = append(lines, "说明："+input)
	}
	if card, err := c.decisionCard(ctx, workspaceID, issue, lines); err == nil {
		reply.Card = card
	}
	return reply
}

// resolveContribution loads the installation, rule, button and hook a token
// names, and returns a user-facing refusal when any is gone or disabled.
func (c *PluginCardActions) resolveContribution(ctx context.Context, workspaceID pgtype.UUID, claims pluginCardClaims) (db.PluginInstallation, plugincontract.CardButtonRule, plugincontract.CardButton, plugincontract.Hook, string) {
	var none db.PluginInstallation
	installationID, err := util.ParseUUID(claims.InstallationID)
	if err != nil {
		return none, plugincontract.CardButtonRule{}, plugincontract.CardButton{}, plugincontract.Hook{}, "按钮已失效"
	}
	installation, err := c.h.Queries.GetPluginInstallation(ctx, installationID)
	if err != nil || uuidToString(installation.WorkspaceID) != uuidToString(workspaceID) {
		return none, plugincontract.CardButtonRule{}, plugincontract.CardButton{}, plugincontract.Hook{}, "该插件已卸载"
	}
	if !installation.Enabled {
		return none, plugincontract.CardButtonRule{}, plugincontract.CardButton{}, plugincontract.Hook{}, "该插件已停用"
	}
	manifest, err := service.ParseInstallationManifest(installation)
	if err != nil {
		return none, plugincontract.CardButtonRule{}, plugincontract.CardButton{}, plugincontract.Hook{}, "插件配置无法读取"
	}
	rule, ok := manifest.CardButtonRule(claims.RuleKey)
	if !ok {
		return none, plugincontract.CardButtonRule{}, plugincontract.CardButton{}, plugincontract.Hook{}, "插件已不再提供这个按钮"
	}
	button, ok := rule.Button(claims.ButtonKey)
	if !ok {
		return none, plugincontract.CardButtonRule{}, plugincontract.CardButton{}, plugincontract.Hook{}, "插件已不再提供这个按钮"
	}
	hook, err := service.FindHook(installation, rule.Hook)
	if err != nil || !service.HookAllowsTrigger(hook, plugincontract.TriggerCardAction) {
		return none, plugincontract.CardButtonRule{}, plugincontract.CardButton{}, plugincontract.Hook{}, "插件已不再提供这个按钮"
	}
	return installation, rule, button, hook, ""
}

// resolveClicker maps the operator to a Multica user: first the member's
// binding on this bot (open_id is per app), then union_id, which every app of
// the same developer shares.
func (c *PluginCardActions) resolveClicker(ctx context.Context, inst lark.Installation, event lark.CardActionEvent) (db.User, bool) {
	if event.OperatorOpenID != "" {
		binding, err := c.h.Queries.GetChannelUserBindingByUserID(ctx, db.GetChannelUserBindingByUserIDParams{
			InstallationID: inst.ID,
			ChannelUserID:  event.OperatorOpenID,
		})
		if err == nil && binding.MulticaUserID.Valid {
			if user, err := c.h.Queries.GetUser(ctx, binding.MulticaUserID); err == nil {
				return user, true
			}
		}
	}
	if event.OperatorUnionID != "" {
		if user, err := c.h.Queries.GetUserByFeishuUnionID(ctx, pgtype.Text{String: event.OperatorUnionID, Valid: true}); err == nil {
			return user, true
		}
	}
	return db.User{}, false
}

func (c *PluginCardActions) alreadyClaimed(ctx context.Context, workspaceID pgtype.UUID, issue db.Issue, messageID, ruleKey string) *lark.CardActionReply {
	existing, err := c.h.Queries.GetPluginCardAction(ctx, db.GetPluginCardActionParams{MessageID: messageID, RuleKey: ruleKey})
	if err != nil || existing.Status != "done" {
		return cardToast(lark.CardToastInfo, "正在处理，请稍候")
	}
	reply := cardToast(lark.CardToastInfo, "这张卡片已经处理过了")
	if existing.ResultText.Valid {
		if card, err := c.decisionCard(ctx, workspaceID, issue, []string{existing.ResultText.String}); err == nil {
			reply.Card = card
		}
	}
	return reply
}

func (c *PluginCardActions) applyEffects(ctx context.Context, caller service.PluginActionCaller, userID pgtype.UUID, issue db.Issue, effects []plugincontract.CardActionEffect) []string {
	var failures []string
	for _, effect := range effects {
		var status, message string
		switch effect.Type {
		case plugincontract.CardEffectComment:
			status, message = c.h.pluginCommentAsMember(ctx, caller, userID, issue, sanitizeNullBytes(effect.Content))
		case plugincontract.CardEffectSetStatus:
			status, message = c.h.pluginSetStatusAsMember(ctx, caller, userID, issue, strings.TrimSpace(effect.Status))
		}
		if status != pluginItemOK {
			failures = append(failures, effect.Type+": "+message)
		}
	}
	return failures
}

func (c *PluginCardActions) finish(id pgtype.UUID, status, resultText, message string) {
	params := db.FinishPluginCardActionParams{ID: id, Status: status}
	if resultText != "" {
		params.ResultText = pgtype.Text{String: truncatePluginText(resultText, 200), Valid: true}
	}
	if message != "" {
		params.Error = pgtype.Text{String: truncatePluginText(message, 500), Valid: true}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := c.h.Queries.FinishPluginCardAction(ctx, params); err != nil {
		c.logger.Warn("plugin card action: finish failed", "error", err)
	}
}

func (c *PluginCardActions) decisionCard(ctx context.Context, workspaceID pgtype.UUID, issue db.Issue, lines []string) (json.RawMessage, error) {
	workspace, err := c.h.Queries.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	identifier := fmt.Sprintf("%s-%d", workspace.IssuePrefix, issue.Number)
	return feishunotify.RenderDecisionCard(c.h.cfg.AppURL, workspace.Slug, identifier, issue.Title, lines)
}

func cardHookTimeoutMs(declared int) int {
	limit := int(pluginCardHookTimeout / time.Millisecond)
	if declared <= 0 || declared > limit {
		return limit
	}
	return declared
}

func hookErrorText(result service.HookResult, err error) string {
	if result.Error != "" {
		return result.Error
	}
	var pluginErr *service.PluginError
	if errors.As(err, &pluginErr) {
		return pluginErr.Message
	}
	return "hook call failed"
}

func decodeGrantedScopes(raw []byte) []string {
	var scopes []string
	_ = json.Unmarshal(raw, &scopes)
	return scopes
}

func displayName(user db.User) string {
	if strings.TrimSpace(user.Name) != "" {
		return user.Name
	}
	return "成员"
}

func cardTimeZone() *time.Location {
	if location, err := time.LoadLocation("Asia/Shanghai"); err == nil {
		return location
	}
	return time.UTC
}
