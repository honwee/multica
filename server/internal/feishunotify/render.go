package feishunotify

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// excerptRunes caps the comment or result text quoted in a message.
const excerptRunes = 200

// CardTitle heads every notification card.
const CardTitle = "Issue 更新"

// maxMergedLines caps how many merged notifications one message lists.
const maxMergedLines = 10

var statusLabels = map[string]string{
	"backlog":     "待规划",
	"todo":        "待办",
	"in_progress": "进行中",
	"in_review":   "审核中",
	"done":        "已完成",
	"blocked":     "已阻塞",
	"cancelled":   "已取消",
}

var priorityLabels = map[string]string{
	"urgent": "紧急",
	"high":   "高",
	"medium": "中",
	"low":    "低",
	"none":   "无优先级",
}

// render builds the schema 2.0 interactive card for a batch on one issue.
// Member-written text (issue title, names, comment excerpts) goes into
// plain_text elements so it can never render as a link; only the issue link
// the server builds is markdown.
func (n *Notifier) render(ctx context.Context, batch []event) (string, error) {
	first := batch[0]
	issueID, err := util.ParseUUID(first.IssueID)
	if err != nil {
		return "", err
	}
	issue, err := n.q.GetIssue(ctx, issueID)
	if err != nil {
		return "", fmt.Errorf("load issue: %w", err)
	}
	ws, err := n.q.GetWorkspace(ctx, issue.WorkspaceID)
	if err != nil {
		return "", fmt.Errorf("load workspace: %w", err)
	}
	identifier := fmt.Sprintf("%s-%d", ws.IssuePrefix, issue.Number)
	if ws.IssuePrefix == "" {
		identifier = fmt.Sprintf("#%d", issue.Number)
	}

	names := map[string]string{}
	var elements []any
	if len(batch) == 1 {
		elements = append(elements, plainDiv(n.describe(ctx, first, names)))
		if excerpt := Excerpt(first.Body); excerpt != "" && quotesBody(first.Type) {
			elements = append(elements, plainDiv(excerpt))
		}
	} else {
		lines := []string{fmt.Sprintf("1 分钟内有 %d 条更新：", len(batch))}
		shown := batch
		if len(shown) > maxMergedLines {
			shown = shown[len(shown)-maxMergedLines:]
		}
		for _, ev := range shown {
			line := "· " + n.describe(ctx, ev, names)
			if excerpt := Excerpt(ev.Body); excerpt != "" && quotesBody(ev.Type) {
				line += "：" + truncateRunes(excerpt, 80)
			}
			lines = append(lines, line)
		}
		if hidden := len(batch) - len(shown); hidden > 0 {
			lines = append(lines, fmt.Sprintf("……另有 %d 条较早的更新", hidden))
		}
		elements = append(elements, plainDiv(strings.Join(lines, "\n")))
	}
	if link := n.issueLink(ws.Slug, identifier); link != "" {
		elements = append(elements, map[string]any{
			"tag":     "markdown",
			"content": "[在 Multica 中查看](" + link + ")",
		})
	}

	buttons := n.cardButtonElements(ctx, first)
	elements = append(elements, buttons...)

	header := identifier + " " + issue.Title
	config := map[string]any{
		"summary": map[string]any{"content": truncateRunes(header+" · "+n.describe(ctx, batch[len(batch)-1], names), 100)},
	}
	if len(buttons) > 0 {
		// The button callback replaces this card with the decision.
		config["update_multi"] = true
	}
	card := map[string]any{
		"schema": "2.0",
		"config": config,
		// The fixed title tells a notification apart from the agent's chat
		// replies when the agent's bot sends it.
		"header": map[string]any{
			"title":    map[string]any{"tag": "plain_text", "content": CardTitle},
			"subtitle": map[string]any{"tag": "plain_text", "content": truncateRunes(header, 120)},
			"template": "blue",
		},
		"body": map[string]any{"elements": elements},
	}
	out, err := json.Marshal(card)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func plainDiv(text string) map[string]any {
	return map[string]any{
		"tag":  "div",
		"text": map[string]any{"tag": "plain_text", "content": text},
	}
}

func (n *Notifier) issueLink(slug, identifier string) string {
	base := strings.TrimRight(n.cfg.AppURL, "/")
	if base == "" || slug == "" {
		return ""
	}
	return base + "/" + url.PathEscape(slug) + "/issues/" + url.PathEscape(identifier)
}

// quotesBody reports whether an inbox type's body is text worth quoting
// (a comment or an agent result) rather than a restated title.
func quotesBody(notifType string) bool {
	switch notifType {
	case "new_comment", "mentioned", "task_completed", "task_failed", "agent_blocked", "agent_completed", "children_done":
		return true
	}
	return false
}

// describe renders one notification as a short Chinese sentence.
func (n *Notifier) describe(ctx context.Context, ev event, names map[string]string) string {
	actor := n.actorName(ctx, ev.ActorType, ev.ActorID, names)
	d := ev.Details
	switch ev.Type {
	case "issue_assigned":
		return actor + " 把它分配给了你"
	case "unassigned":
		return actor + " 取消了你的分配"
	case "assignee_changed":
		if d["new_assignee_id"] == "" {
			return actor + " 移除了负责人"
		}
		return actor + " 把负责人改为 " + n.actorName(ctx, d["new_assignee_type"], d["new_assignee_id"], names)
	case "status_changed":
		return actor + " 把状态改为「" + n.statusLabel(ctx, ev.WorkspaceID, d["to"]) + "」"
	case "priority_changed":
		return actor + " 把优先级改为「" + labelOr(priorityLabels, d["to"]) + "」"
	case "start_date_changed":
		return actor + " 修改了开始日期" + dateSuffix(d["to"])
	case "due_date_changed":
		return actor + " 修改了截止日期" + dateSuffix(d["to"])
	case "new_comment":
		return actor + " 评论了"
	case "mentioned":
		return actor + " 提到了你"
	case "task_completed", "agent_completed":
		return actor + " 完成了任务"
	case "task_failed":
		return actor + " 的任务失败了"
	case "agent_blocked":
		return actor + " 遇到阻塞，需要处理"
	case "reaction_added":
		if emoji := d["emoji"]; emoji != "" {
			return actor + " 回应了 " + emoji
		}
		return actor + " 添加了回应"
	case "review_requested":
		return actor + " 请你审核"
	case "children_done":
		return "子任务已全部完成"
	}
	if ev.Title != "" {
		return ev.Title
	}
	return "有新的动态"
}

func dateSuffix(to string) string {
	if to == "" {
		return "（已清除）"
	}
	return "为 " + to
}

func labelOr(labels map[string]string, key string) string {
	if label, ok := labels[key]; ok {
		return label
	}
	return key
}

func (n *Notifier) statusLabel(ctx context.Context, workspaceID, key string) string {
	if label, ok := statusLabels[key]; ok {
		return label
	}
	wsID, err := util.ParseUUID(workspaceID)
	if err != nil {
		return key
	}
	entry, err := n.q.GetIssueStatusEntryByKey(ctx, db.GetIssueStatusEntryByKeyParams{WorkspaceID: wsID, Key: key})
	if err != nil || entry.Name == "" {
		return key
	}
	return entry.Name
}

func (n *Notifier) actorName(ctx context.Context, actorType, actorID string, cache map[string]string) string {
	if actorType == "system" || actorID == "" {
		return "系统"
	}
	cacheKey := actorType + ":" + actorID
	if name, ok := cache[cacheKey]; ok {
		return name
	}
	name := "有人"
	if id, err := util.ParseUUID(actorID); err == nil {
		switch actorType {
		case "member":
			if u, err := n.q.GetUser(ctx, id); err == nil && u.Name != "" {
				name = u.Name
			}
		case "agent":
			if a, err := n.q.GetAgent(ctx, id); err == nil && a.Name != "" {
				name = a.Name
			}
		}
	}
	cache[cacheKey] = name
	return name
}

var (
	markdownLink  = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`)
	markdownNoise = regexp.MustCompile("[*_`#>~]+")
	whitespace    = regexp.MustCompile(`\s+`)
)

// Excerpt flattens markdown to plain text and keeps about the first 200
// characters. Links keep only their text, so mentions read as "@Name".
func Excerpt(body string) string {
	text := markdownLink.ReplaceAllString(body, "$1")
	text = markdownNoise.ReplaceAllString(text, "")
	text = strings.TrimSpace(whitespace.ReplaceAllString(text, " "))
	return truncateRunes(text, excerptRunes)
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}
