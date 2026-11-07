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

// ---- 经验提案 grouping ------------------------------------------------------
//
// A proposal body starts with "#924 [能力] 【缺信息】…" and then indented lines
// 改动：<path>（追加）/ 内容：… / 理由：… / 依据：…, ending in the footer. Live
// bodies are multi-line, but a body flattened onto one line still parses: each
// field runs until the next field label or the footer.

const PROPOSAL_FIELD_STOP = String.raw`(?=\s*(?:改动|内容|理由|依据)[:：]|\s*_评论|$)`;

function proposalField(text, label) {
  const match = text.match(new RegExp(`${label}[:：]\\s*([\\s\\S]*?)${PROPOSAL_FIELD_STOP}`));
  const value = match ? match[1].trim() : "";
  return value || null;
}

export function parseProposal(title, description) {
  const head = String(title ?? "");
  const body = String(description ?? "");
  const firstLine = body.split("\n", 1)[0];
  const tag = (head.match(/\[([^\[\]\s]{1,12})\]/) ?? firstLine.match(/\[([^\[\]\s]{1,12})\]/))?.[1] ?? null;
  const change = body.match(/改动[:：]\s*([^\s（(]+)\s*(?:[（(]([^）)\n]+)[）)])?/);
  return {
    tag,
    path: change ? change[1] : null,
    change: change?.[2] ?? null,
    content: proposalField(body, "内容"),
    reason: proposalField(body, "理由"),
    basis: proposalField(body, "依据"),
  };
}

export const UNGROUPED = "未分组";

// Proposals (already carrying `.proposal` from parseProposal) grouped by the
// file they change, largest group first; proposals without a readable body or
// path go last under 未分组.
export function groupProposals(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.proposal?.path ?? UNGROUPED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups]
    .map(([path, list]) => ({ path, items: list }))
    .sort((a, b) => {
      if ((a.path === UNGROUPED) !== (b.path === UNGROUPED)) return a.path === UNGROUPED ? 1 : -1;
      return b.items.length - a.items.length || a.path.localeCompare(b.path);
    });
}

// Tags present on the proposals with their counts, most frequent first.
export function proposalTags(items) {
  const counts = new Map();
  for (const item of items) {
    const tag = item.proposal?.tag;
    if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// tags: a Set of selected tags (empty = all); query: substring of the title.
export function filterProposals(items, { tags, query } = {}) {
  const needle = String(query ?? "").trim().toLowerCase();
  return items.filter((item) => {
    if (tags?.size && !tags.has(item.proposal?.tag)) return false;
    if (needle && !String(item.title ?? "").toLowerCase().includes(needle)) return false;
    return true;
  });
}

// ---- superseded drafts ------------------------------------------------------
//
// Hermes often rewrites a draft before the first one is decided: D176–D181 are
// six replies to the same person within a minute, D184/D188/D190 chase the
// same REQ field three times. Only the newest is "current"; the others are
// offered for a bulk 「不要 已被新草稿 Dxxx 替代」.

export const SUPERSEDE_WINDOW_MINUTES = 10;

const REF_ID = /REQ-\d{8}-[0-9A-F]{8}|WK-\d{8}-[0-9A-F]{6}/;

// "D190 待确认：…" → "D190".
export function draftNumber(title) {
  const match = String(title ?? "").match(/^(D\d+)\s/);
  return match ? match[1] : null;
}

// Who a draft is addressed to. `explicit` is false for 当前会话, whose
// conversation the title does not name.
//   发给 dm:gabby：…         → dm:gabby
//   回复 Lumist.Grace（私聊） → dm:Lumist.Grace
//   发给 当前会话：…          → 当前会话 (not explicit)
export function draftRecipient(title) {
  const text = String(title ?? "").replace(/^D\d+\s*待确认[:：]\s*/, "");
  const reply = text.match(/^回复\s+(.+?)\s*[（(]私聊[）)]/);
  if (reply) return { key: `dm:${reply[1]}`, explicit: true };
  const send = text.match(/^发给\s+(.+?)：/);
  if (!send) return null;
  const name = send[1].trim();
  if (name === "当前会话") return { key: name, explicit: false };
  return { key: name, explicit: true };
}

// The REQ-/WK- order a draft is about: the title wins over the body.
export function draftReference(title, description) {
  return String(title ?? "").match(REF_ID)?.[0] ?? String(description ?? "").match(REF_ID)?.[0] ?? null;
}

// Waiting drafts → { current: Map(keptId → older[]), superseded: [{ item, kept }] }.
// Same recipient AND (same REQ/WK reference, or neither has one and the older
// was created within the window of the kept one). A 当前会话 draft only merges
// on a shared reference.
export function findSupersededDrafts(drafts, windowMinutes = SUPERSEDE_WINDOW_MINUTES) {
  const buckets = new Map();
  for (const item of drafts) {
    const recipient = draftRecipient(item.title);
    if (!recipient) continue;
    const ref = draftReference(item.title, item.description);
    if (!ref && !recipient.explicit) continue;
    const key = `${recipient.key}\u0000${ref ?? ""}`;
    if (!buckets.has(key)) buckets.set(key, { ref, items: [] });
    buckets.get(key).items.push(item);
  }
  const current = new Map();
  const superseded = [];
  const windowMs = windowMinutes * 60000;
  for (const { ref, items } of buckets.values()) {
    const sorted = [...items].sort((a, b) => newestFirst(a, b));
    let rest = sorted;
    while (rest.length) {
      const [kept, ...older] = rest;
      const keptAt = Date.parse(kept.created_at);
      const covered = ref ? older : older.filter((item) => keptAt - Date.parse(item.created_at) <= windowMs);
      if (covered.length) {
        current.set(kept.id, covered);
        for (const item of covered) superseded.push({ item, kept });
      }
      rest = older.filter((item) => !covered.includes(item));
    }
  }
  return { current, superseded };
}

function newestFirst(a, b) {
  const delta = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (delta) return delta;
  return (Number(draftNumber(b.title)?.slice(1)) || 0) - (Number(draftNumber(a.title)?.slice(1)) || 0);
}

export function supersededReason(kept) {
  return `已被新草稿 ${draftNumber(kept.title) ?? kept.identifier} 替代`;
}

// ---- asks that reference drafts ---------------------------------------------

// "Q30 分身请教：D165 待确认：…" / "B. B 继续用本单，批准 D187 催销售补三样" →
// ["D165"], ["D187"]. A D inside an id like REQ-…-D1234567 does not count.
export function referencedDrafts(title, description) {
  const text = `${title ?? ""}\n${description ?? ""}`;
  const found = [];
  for (const match of text.matchAll(/(?<![\w-])(D\d+)(?![\w-])/g)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

// First line of the newest comment that carries a protocol decision on a
// draft, e.g. "同意" or "不要 已被新草稿 D190 替代"; null if none.
export function draftDecisionLine(comments, description) {
  const verbs = protocolVerbs(CARD_DRAFT, description);
  const sorted = [...(comments ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const comment of sorted) {
    const line = String(comment.content ?? "").trim().split("\n", 1)[0].trim();
    if (line === verbs.approve || line.startsWith(`${verbs.revise} `) || line.startsWith(`${verbs.reject} `)) return line;
  }
  return null;
}

export function truncateText(text, max) {
  const chars = [...String(text ?? "")];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}
