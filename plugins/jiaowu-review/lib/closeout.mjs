// Closing out cards left behind when a 问课单 ends.
//
// Two halves because of what each hook's callback token may reach:
//
// - The event hook (issue.created / issue.status_changed) gets a token scoped
//   to the event's own issue. It can read and write plugin storage but cannot
//   touch any other issue, so it only records facts: which 问课单 exists, which
//   waiting cards hang on it, and that a 问课单 just ended.
// - The schedule hook gets a workspace-wide token and does the writing: for an
//   ended 问课单 it re-reads every recorded card and leaves one closeout comment
//   on each that is still waiting. It never changes a status.
//
// Storage is keyed per fact (not one list per order) so concurrent events
// never overwrite each other, and keys are deleted once used so the 1000-key
// quota only ever holds what is still open.

import {
  CARD_DRAFT,
  classifyCard,
  closeoutComment,
  isCloseoutComment,
  isWaiting,
  referencedWenkeId,
  wenkeEnding,
  wenkeOrderId,
} from "./protocol.mjs";

export const KEY_ORDER = "wk:"; //        wk:<WK>             → 问课单 issue id
export const KEY_PARENT = "parent:"; //   parent:<issue id>   → <WK>
export const KEY_CARD = "card:"; //       card:<WK>:<issue id> → card created_at
export const KEY_PENDING = "pending:"; // pending:<WK>        → { ending, at }

// Tutor cards are sub-issues of the 问课单. Drafts name the order in text.
// Asks are excluded on purpose: they are often ABOUT the stopped order
// ("整单已停止，但…怎么走？") and still need an answer.
export async function wenkeFor(issue, store) {
  if (classifyCard(issue.title) === CARD_DRAFT) {
    return referencedWenkeId(issue.title, issue.description);
  }
  if (issue.parent_issue_id) {
    return (await store.get(`${KEY_PARENT}${issue.parent_issue_id}`)) ?? null;
  }
  return null;
}

// Event half. `issue` is the event payload's issue.
export async function recordEvent(eventType, issue, store) {
  if (!issue?.id) return { skipped: "no issue" };
  const order = wenkeOrderId(issue.title);
  if (order) {
    await store.put(`${KEY_ORDER}${order}`, issue.id);
    await store.put(`${KEY_PARENT}${issue.id}`, order);
    const ending = eventType === "issue.status_changed" ? wenkeEnding(issue.status) : null;
    if (ending) {
      await store.put(`${KEY_PENDING}${order}`, JSON.stringify({ ending, at: issue.updated_at ?? new Date().toISOString() }));
      return { order, ending };
    }
    return { order };
  }

  const wk = await wenkeFor(issue, store);
  if (!wk) return { skipped: "not linked to a 问课单" };
  const key = `${KEY_CARD}${wk}:${issue.id}`;
  if (eventType === "issue.created" && isWaiting(issue.status)) {
    await store.put(key, issue.created_at ?? new Date().toISOString());
    return { card: issue.id, order: wk };
  }
  if (eventType === "issue.status_changed" && !isWaiting(issue.status)) {
    await store.delete(key);
    return { released: issue.id, order: wk };
  }
  return { order: wk };
}

// Schedule half. `api` reads issues and comments and posts comments, as the
// installation.
export async function sweep(store, api) {
  const keys = await store.keys();
  const report = { orders: 0, commented: [], skipped: [], failed: [] };
  for (const key of keys.filter((name) => name.startsWith(KEY_PENDING))) {
    const order = key.slice(KEY_PENDING.length);
    report.orders += 1;
    try {
      await sweepOrder(order, keys, store, api, report);
    } catch (error) {
      // Leave the pending key so the next run retries this order.
      report.failed.push({ order, error: String(error?.message ?? error) });
    }
  }
  return report;
}

async function sweepOrder(order, keys, store, api, report) {
  const pending = parsePending(await store.get(`${KEY_PENDING}${order}`));
  const orderIssueId = await store.get(`${KEY_ORDER}${order}`);
  const orderIssue = orderIssueId ? await api.getIssue(orderIssueId) : null;
  const ending = orderIssue ? wenkeEnding(orderIssue.status) : null;
  const cardKeys = keys.filter((name) => name.startsWith(`${KEY_CARD}${order}:`));

  if (!ending) {
    // 问课重开 moved it back (or it is gone): nothing to close; keep the cards
    // recorded in case it ends again.
    await store.delete(`${KEY_PENDING}${order}`);
    report.skipped.push({ order, reason: orderIssue ? "reopened" : "order not found" });
    return;
  }

  for (const cardKey of cardKeys) {
    const cardId = cardKey.slice(`${KEY_CARD}${order}:`.length);
    const card = await api.getIssue(cardId);
    if (card && isWaiting(card.status) && createdBefore(card, pending?.at)) {
      const comments = await api.listComments(cardId);
      if (!comments.some((comment) => isCloseoutComment(comment.content))) {
        await api.comment(cardId, closeoutComment(order, ending));
        report.commented.push(cardId);
      }
    }
    await store.delete(cardKey);
  }
  await store.delete(`${KEY_PENDING}${order}`);
  await store.delete(`${KEY_ORDER}${order}`);
  if (orderIssueId) await store.delete(`${KEY_PARENT}${orderIssueId}`);
}

// A card written after the order ended was written on purpose; leave it.
function createdBefore(card, endedAt) {
  if (!endedAt) return true;
  const created = Date.parse(card.created_at);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(created) || !Number.isFinite(ended)) return true;
  return created <= ended;
}

function parsePending(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
