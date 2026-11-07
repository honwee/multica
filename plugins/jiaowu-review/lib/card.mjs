// Feishu card button → the comment Hermes expects.
//
// The manifest declares three rules (draft, proposal, ask). A click arrives as
// { rule, button, input }; the issue is read back from Multica so the verbs
// come from the card's own footer and the options from its own body.

import {
  CARD_ASK,
  CARD_DRAFT,
  CARD_PROPOSAL,
  DECISION_APPROVE,
  DECISION_REJECT,
  DECISION_REVISE,
  DECISION_STATUS_TEXT,
  askAnswerComment,
  classifyCard,
  decisionComment,
  isWaiting,
} from "./protocol.mjs";

export const RULE_TYPES = {
  draft: CARD_DRAFT,
  proposal: CARD_PROPOSAL,
  ask: CARD_ASK,
};

const DECISION_BUTTONS = new Set([DECISION_APPROVE, DECISION_REVISE, DECISION_REJECT]);
export const ASK_REPLY_BUTTON = "reply";

// Returns { effects, status_text } for Multica to perform as the clicker, or
// { error } — the hook answers an error with a non-2xx so the click is not
// recorded as decided and the person can try again.
export function cardDecision(click, issue) {
  const type = RULE_TYPES[click?.rule];
  if (!type) return { error: `unknown rule ${click?.rule}` };
  if (!issue) return { error: "issue not readable" };
  if (classifyCard(issue.title) !== type) return { error: "card type changed" };
  if (!isWaiting(issue.status)) return { error: "card already closed" };

  const button = String(click.button ?? "");
  const input = String(click.input ?? "").trim();

  if (type === CARD_ASK) {
    if (button === ASK_REPLY_BUTTON) {
      if (!input) return { error: "reply needs text" };
      return comment(input, `已回复：${truncate(input, 20)}`);
    }
    const answer = askAnswerComment(issue.description, button);
    if (answer.error) return { error: answer.error };
    return comment(answer.content, `已选 ${answer.content}`);
  }

  if (!DECISION_BUTTONS.has(button)) return { error: `unknown button ${button}` };
  const result = decisionComment(type, issue.description, button, input);
  if (result.error) return { error: result.error };
  return comment(result.content, DECISION_STATUS_TEXT[button]);
}

function comment(content, statusText) {
  return { effects: [{ type: "comment", content }], status_text: statusText };
}

function truncate(text, max) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}
