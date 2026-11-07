// Pure display helpers for the queue page. No DOM, no bridge: build.mjs
// inlines this file into ui/main.js next to lib/protocol.mjs.

import { CARD_ASK, CARD_DRAFT, CARD_OTHER, CARD_PROPOSAL, classifyCard } from "../lib/protocol.mjs";

// Tabs in toolbar order.
export const QUEUE_TABS = [
  { type: CARD_PROPOSAL, label: "提案" },
  { type: CARD_DRAFT, label: "草稿" },
  { type: CARD_ASK, label: "请教" },
  { type: CARD_OTHER, label: "其他" },
];

const NUMBER_PREFIX = /^(#\d+|D\d+|Q\d+)/;

// "#924 经验提案：…" → "#924"; cards without a protocol number use the issue
// identifier so every row still has something in the number column.
export function cardNumber(item) {
  return String(item?.title ?? "").match(NUMBER_PREFIX)?.[1] ?? item?.identifier ?? "";
}

// The title without what the number column and the tab already say.
const TITLE_PREFIX = {
  // The tag has its own badge on proposal rows.
  [CARD_PROPOSAL]: /^#\d+\s*(?:经验提案)?[:：]?\s*(?:\[[^\[\]\s]{1,12}\]\s*)?/,
  [CARD_DRAFT]: /^D\d+\s*(?:待确认)?[:：]?\s*/,
  [CARD_ASK]: /^Q\d+\s*(?:分身请教)?[:：]?\s*/,
};

export function displayTitle(item) {
  const title = String(item?.title ?? "");
  const prefix = TITLE_PREFIX[classifyCard(title)];
  const stripped = prefix ? title.replace(prefix, "") : title;
  return stripped || title;
}

// Matches a card against the search box: number or title, case-insensitive.
export function matchesQuery(item, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return true;
  return String(item?.title ?? "").toLowerCase().includes(needle) || String(item?.identifier ?? "").toLowerCase().includes(needle);
}

// The reject button speaks the protocol of what is selected: drafts say 不要,
// proposals say 拒绝.
export function rejectLabel(selected) {
  const types = new Set(selected.map((item) => classifyCard(item.title)));
  if (types.has(CARD_DRAFT) && types.has(CARD_PROPOSAL)) return "不要 / 拒绝";
  return types.has(CARD_PROPOSAL) ? "拒绝" : "不要";
}

// Batch outcome → toast. Success clears itself; anything that failed stays so
// the reader can open the per-card reasons.
export function resultToast(label, ok, failed) {
  if (!failed.length) return { kind: "success", title: `${label}：成功 ${ok} 条`, details: [], sticky: false };
  if (ok) {
    return { kind: "partial", title: `${label}：成功 ${ok} 条，失败 ${failed.length} 条`, details: failed, sticky: true };
  }
  return { kind: "error", title: `${label}失败：${failed.length} 条都没有发出`, details: failed, sticky: true };
}
