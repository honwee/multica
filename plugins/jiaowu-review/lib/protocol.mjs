// Approval protocol of the Hermes twin, as read off its cards.
//
// Pure functions shared by the page, the hook server and the tests. Hermes
// owns the protocol; this file only recognises it. Every card ends with a
// footer that states the exact verbs it accepts, so the verbs are read from
// that footer and the per-type defaults below are only a fallback for a card
// whose description is unavailable.
//
// The page is shipped as one script, so this module must stay free of imports
// and of anything but top-level `export function` / `export const`.

export const CARD_DRAFT = "draft";
export const CARD_ASK = "ask";
export const CARD_PROPOSAL = "proposal";
export const CARD_OTHER = "other";

export const CARD_LABELS = {
  [CARD_DRAFT]: "草稿",
  [CARD_ASK]: "请教",
  [CARD_PROPOSAL]: "经验提案",
  [CARD_OTHER]: "其他",
};

// Footers seen on live cards (2026-11-07):
//   draft:    评论「同意」执行，「改 新内容」修改后执行，「不要 理由」放弃
//   proposal: 评论「同意」写入规范，「修改 新内容」改后写入，「拒绝 理由」放弃
//   ask:      直接在评论里写答案（有选项时可以只写字母）
export const DEFAULT_VERBS = {
  [CARD_DRAFT]: { approve: "同意", revise: "改", reject: "不要" },
  [CARD_PROPOSAL]: { approve: "同意", revise: "修改", reject: "拒绝" },
};

const DRAFT_TITLE = /^D\d+\s/;
const ASK_TITLE = /^Q\d+\s/;
const PROPOSAL_TITLE = /^#\d+\s*经验提案/;

export function classifyCard(title) {
  const text = String(title ?? "");
  if (DRAFT_TITLE.test(text)) return CARD_DRAFT;
  if (ASK_TITLE.test(text)) return CARD_ASK;
  if (PROPOSAL_TITLE.test(text)) return CARD_PROPOSAL;
  return CARD_OTHER;
}

// Only drafts and proposals follow the approve / revise / reject protocol.
// Asks are answered one by one; "other" cards (问课单, tutor cards) take free
// commands that a batch must never send.
export function canBatch(type) {
  return type === CARD_DRAFT || type === CARD_PROPOSAL;
}

export function protocolVerbs(type, description) {
  const fallback = DEFAULT_VERBS[type];
  if (!fallback) return null;
  const text = String(description ?? "");
  const approve = text.match(/「(同意)」/);
  const revise = text.match(/「(改|修改)\s*新内容」/);
  const reject = text.match(/「(不要|拒绝)\s*理由」/);
  return {
    approve: approve ? approve[1] : fallback.approve,
    revise: revise ? revise[1] : fallback.revise,
    reject: reject ? reject[1] : fallback.reject,
  };
}

export const DECISION_APPROVE = "approve";
export const DECISION_REVISE = "revise";
export const DECISION_REJECT = "reject";

export const DECISION_STATUS_TEXT = {
  [DECISION_APPROVE]: "已同意",
  [DECISION_REVISE]: "已提交修改",
  [DECISION_REJECT]: "已放弃",
};

// The comment that carries one decision, or an error string. Revise and
// reject need text: Hermes reads 「改」 with nothing after it as an empty
// replacement, and the protocol names a reason for every rejection.
export function decisionComment(type, description, decision, input) {
  const verbs = protocolVerbs(type, description);
  if (!verbs) return { error: "这张卡片不走「同意 / 修改 / 不要」流程" };
  const text = String(input ?? "").trim();
  switch (decision) {
    case DECISION_APPROVE:
      return { content: verbs.approve };
    case DECISION_REVISE:
      if (!text) return { error: "请先填写修改后的内容" };
      return { content: `${verbs.revise} ${text}` };
    case DECISION_REJECT:
      if (!text) return { error: "请先填写不要的理由" };
      return { content: `${verbs.reject} ${text}` };
    default:
      return { error: "未知操作" };
  }
}

// Options on an ask card, in order, e.g. "A. A 由 maddie 接手 B. B 继续用本单".
// Only letters that appear as a run starting at A count, so a stray "B." in
// prose does not invent an option.
export function parseAskOptions(description) {
  const text = String(description ?? "");
  const pattern = /(?:^|\s)([A-H])\.\s+(.*?)(?=\s+[A-H]\.\s|\s+分身倾向[:：]|\s+问课单[:：]|\s+_|$)/gs;
  const options = [];
  const seen = new Set();
  for (const match of text.matchAll(pattern)) {
    const letter = match[1];
    if (seen.has(letter)) continue;
    const expected = String.fromCharCode(65 + options.length);
    if (letter !== expected) continue;
    seen.add(letter);
    options.push({ letter, text: match[2].replace(/^[A-H]\s+/, "").trim() });
  }
  return options;
}

export function askAnswerComment(description, choice) {
  const letter = String(choice ?? "").trim().toUpperCase();
  const options = parseAskOptions(description);
  if (!options.some((option) => option.letter === letter)) {
    return { error: options.length ? `这条请教没有选项 ${letter}` : "这条请教没有选项，请直接回复" };
  }
  return { content: letter };
}

// 问课单 (tutor-matching order) linkage.
//
// A 问课单 is an issue titled "…｜N 位导师…｜WK-YYYYMMDD-XXXXXX"; its tutor cards
// are its sub-issues. Drafts and asks are NOT sub-issues: they name the order
// in their title or description ("问课 WK-…", "问课单：WK-…").
const WK_ID = /WK-\d{8}-[0-9A-F]{6}/;
const WENKE_TITLE = /｜(WK-\d{8}-[0-9A-F]{6})\s*$/;

export function wenkeOrderId(title) {
  const match = String(title ?? "").match(WENKE_TITLE);
  return match ? match[1] : null;
}

export function referencedWenkeId(title, description) {
  if (wenkeOrderId(title)) return null;
  const match = `${title ?? ""}\n${description ?? ""}`.match(WK_ID);
  return match ? match[0] : null;
}

// Hermes closes a 问课单 by moving it: 问课停止 → cancelled, 问课确定 → done.
// 问课重开 moves it back, so only these two count, read at the moment of use.
export function wenkeEnding(status) {
  if (status === "cancelled") return "已停止";
  if (status === "done") return "已确定";
  return null;
}

export function isWaiting(status) {
  return status !== "done" && status !== "cancelled";
}

// "//" keeps the comment on the board: Hermes documents that a comment
// starting with // (or 备注) is not sent and not executed.
export const CLOSEOUT_MARK = "// 问课单";

export function closeoutComment(wenkeId, ending) {
  return `${CLOSEOUT_MARK} ${wenkeId} ${ending}，此卡建议作废（审批插件自动标记，未改状态）`;
}

export function isCloseoutComment(content) {
  return String(content ?? "").startsWith(CLOSEOUT_MARK);
}

export function waitingMinutes(createdAt, now) {
  const started = Date.parse(createdAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 60000));
}

export function formatWaiting(minutes) {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} 天 ${rest} 小时` : `${days} 天`;
}

// Groups in display order, each sorted longest wait first.
export function groupQueue(issues, now) {
  const groups = { [CARD_DRAFT]: [], [CARD_ASK]: [], [CARD_PROPOSAL]: [], [CARD_OTHER]: [] };
  for (const issue of issues) {
    const type = classifyCard(issue.title);
    groups[type].push({ ...issue, type, waiting: waitingMinutes(issue.created_at, now) });
  }
  for (const list of Object.values(groups)) list.sort((a, b) => b.waiting - a.waiting);
  return [CARD_DRAFT, CARD_ASK, CARD_PROPOSAL, CARD_OTHER].map((type) => ({
    type,
    label: CARD_LABELS[type],
    batch: canBatch(type),
    items: groups[type],
  }));
}

// One batch call per distinct comment: drafts reject with 不要, proposals with
// 拒绝, so a mixed selection becomes two calls.
export function planBatch(selected, decision, input) {
  const byContent = new Map();
  const refused = [];
  for (const issue of selected) {
    const type = classifyCard(issue.title);
    if (!canBatch(type)) {
      refused.push({ issue_id: issue.id, error: "请教和其他卡片不能批量处理" });
      continue;
    }
    const result = decisionComment(type, issue.description, decision, input);
    if (result.error) {
      refused.push({ issue_id: issue.id, error: result.error });
      continue;
    }
    const ids = byContent.get(result.content) ?? [];
    ids.push(issue.id);
    byContent.set(result.content, ids);
  }
  return {
    calls: [...byContent].map(([content, issue_ids]) => ({ content, issue_ids })),
    refused,
  };
}
