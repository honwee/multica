# Workspace Review

Minimal example of the two Lumist fork extension points (see `FORK.md`). Both
are off until a workspace admin turns them on under **Settings → Plugins →
Workspace extensions**.

## Workspace page

`ui/main.js` is a `workspace_page` surface: it appears under **Plugins** in the
Work sidebar and opens as a full page. It lists issues waiting for review and
comments on or approves the ticked ones in one call. Batch calls run as the
signed-in user, each issue is checked on its own, and each write is recorded
with this plugin's id.

## Card buttons

`card_buttons` puts 同意 / 修改 / 不要 on Feishu notification cards whose
issue title starts with `[审批]`. 修改 shows a text input and requires it.

Only cards sent by an agent's Feishu bot carry buttons. Each bot app must
subscribe to card callbacks once in the Feishu developer console:

1. **事件与回调 → 回调配置**: set the subscription mode to **使用长连接接收回调**.
2. Add the callback **卡片回传交互** (`card.action.trigger`).
3. Create and publish a new app version.

A click reaches `server/handler.mjs` as a signed request with
`trigger: "card_action"` and `input: { rule, button, input, message_id }`. The
handler answers with effects and a status line; Multica performs the effects as
the clicker, runs each card's decision once, and replaces the card with
"已同意 · <name> · <time>".
