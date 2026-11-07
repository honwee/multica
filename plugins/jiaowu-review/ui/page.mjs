// 审批队列 — the plugin's workspace page.
//
// Source of ui/main.js; `node build.mjs` inlines lib/protocol.mjs and writes the
// single-file entry Multica serves. Edit this file, not ui/main.js.
//
// Every call goes through the host bridge and runs as the signed-in member;
// batch calls are checked issue by issue on the server.

import {
  CARD_ASK,
  CARD_DRAFT,
  DECISION_APPROVE,
  DECISION_REJECT,
  askAnswerComment,
  closeoutComment,
  formatWaiting,
  groupQueue,
  parseAskOptions,
  planBatch,
  referencedWenkeId,
  wenkeEnding,
  wenkeOrderId,
} from "../lib/protocol.mjs";

const BATCH_LIMIT = 100;
const PAGE_LIMIT = 200;
const DETAIL_CONCURRENCY = 5;

// ---- bridge ---------------------------------------------------------------

const pending = new Map();
const port = globalThis.__multicaPluginBridgePortV2;
let sequence = 0;
if (!(port instanceof MessagePort)) throw new Error("Multica surface bridge is unavailable");
delete globalThis.__multicaPluginBridgePortV2;
port.onmessage = (message) => {
  const payload = message.data;
  if (payload?.kind === "theme") {
    for (const [name, value] of Object.entries(payload.theme ?? {})) {
      document.documentElement.style.setProperty(name, value);
    }
    return;
  }
  const entry = pending.get(payload?.id);
  if (!entry) return;
  pending.delete(payload.id);
  if (payload.ok) entry.resolve(payload.data);
  else entry.reject(new Error(`${payload.status}: ${payload.error}`));
};
port.start();

function call(method, path, body) {
  const id = `r${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ id, kind: "action", method, path, body });
  });
}

function resize() {
  port.postMessage({ id: `r${++sequence}`, kind: "ui.resize", height: document.documentElement.scrollHeight + 16 });
}

// ---- data -----------------------------------------------------------------

async function listAll(status) {
  const issues = [];
  let offset = 0;
  for (;;) {
    const page = await call("GET", `/issues?status=${status}&limit=${PAGE_LIMIT}&offset=${offset}`);
    issues.push(...page.issues);
    if (page.next_offset == null) return issues;
    offset = page.next_offset;
  }
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]);
      } catch {
        results[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const state = {
  groups: [],
  stale: [],
  selected: new Map(),
  details: new Map(),
  message: "",
  busy: false,
  armed: null,
};

async function load() {
  state.message = "加载中…";
  render();
  const [waiting, cancelled, done] = await Promise.all([
    listAll("in_review"),
    listAll("cancelled"),
    listAll("done"),
  ]);

  const orders = new Map();
  for (const issue of [...waiting, ...cancelled, ...done]) {
    const order = wenkeOrderId(issue.title);
    if (order) orders.set(order, issue);
  }

  // Drafts need their body for the 问课单 reference; asks for their options.
  const needBody = waiting.filter((issue) => /^(D|Q)\d+\s/.test(issue.title));
  const bodies = await mapLimited(needBody, DETAIL_CONCURRENCY, (issue) => call("GET", `/issues/${issue.id}`));
  state.details = new Map(bodies.filter(Boolean).map((issue) => [issue.id, issue]));

  const now = Date.now();
  state.groups = groupQueue(
    waiting.map((issue) => ({ ...issue, description: state.details.get(issue.id)?.description ?? "" })),
    now,
  );
  state.stale = [];
  for (const item of state.groups.find((group) => group.type === CARD_DRAFT).items) {
    const order = referencedWenkeId(item.title, item.description);
    const orderIssue = order ? orders.get(order) : null;
    const ending = orderIssue ? wenkeEnding(orderIssue.status) : null;
    if (!ending) continue;
    if (Date.parse(item.created_at) > Date.parse(orderIssue.updated_at)) continue;
    state.stale.push({ ...item, order, ending });
  }
  state.selected.clear();
  state.message = "";
  render();
}

// ---- actions --------------------------------------------------------------

async function postBatch(issueIds, content) {
  const results = [];
  for (let start = 0; start < issueIds.length; start += BATCH_LIMIT) {
    const chunk = issueIds.slice(start, start + BATCH_LIMIT);
    const answer = await call("POST", "/issue-batches/comments", { issue_ids: chunk, content });
    results.push(...answer.results);
  }
  return results;
}

async function run(label, work) {
  if (state.busy) return;
  state.busy = true;
  state.armed = null;
  state.message = `${label}中…`;
  render();
  try {
    const { ok, failed } = await work();
    state.message = `${label}：成功 ${ok} 条` + (failed.length ? `，失败 ${failed.length} 条（${failed.join("；")}）` : "");
    await load();
  } catch (error) {
    state.message = `${label}失败：${error.message ?? error}`;
    render();
  } finally {
    state.busy = false;
    render();
  }
}

function summarize(results, refused = []) {
  const failed = [
    ...results.filter((item) => item.status !== "ok").map((item) => `${item.issue_id} ${item.error ?? item.status}`),
    ...refused.map((item) => `${item.issue_id} ${item.error}`),
  ];
  return { ok: results.filter((item) => item.status === "ok").length, failed };
}

function batchDecision(decision, reason) {
  const selected = [...state.selected.values()];
  const plan = planBatch(selected, decision, reason);
  return run(decision === DECISION_APPROVE ? "批量同意" : "批量不要", async () => {
    const results = [];
    for (const { content, issue_ids } of plan.calls) results.push(...(await postBatch(issue_ids, content)));
    return summarize(results, plan.refused);
  });
}

function answerAsk(issue, choice, text) {
  const result = text != null ? { content: text.trim() } : askAnswerComment(issue.description, choice);
  if (result.error || !result.content) {
    state.message = result.error ?? "请先写答案";
    render();
    return;
  }
  return run(`回复 ${issue.identifier}`, async () => summarize(await postBatch([issue.id], result.content)));
}

function closeout(items) {
  return run("发收口评论", async () => {
    const results = [];
    for (const item of items) results.push(...(await postBatch([item.id], closeoutComment(item.order, item.ending))));
    return summarize(results);
  });
}

// Sandboxed frames cannot open confirm(); a destructive-looking action needs a
// second click instead.
function armed(key, label, action) {
  const button = el("button", { disabled: state.busy }, state.armed === key ? `确认${label}？` : label);
  button.onclick = () => {
    if (state.armed !== key) {
      state.armed = key;
      render();
      return;
    }
    action();
  };
  return button;
}

// ---- view -----------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === "style") node.style.cssText = value;
    else if (name in node) node[name] = value;
    else node.setAttribute(name, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

const muted = "color:var(--muted-foreground)";

function row(item, { selectable }) {
  const box = selectable
    ? el("input", {
        type: "checkbox",
        checked: state.selected.has(item.id),
        disabled: state.busy,
        onchange: (event) => {
          if (event.target.checked) state.selected.set(item.id, item);
          else state.selected.delete(item.id);
          render();
        },
      })
    : null;
  return el(
    "li",
    { style: "display:flex; gap:8px; align-items:baseline; padding:4px 0" },
    box,
    el("span", { style: `${muted}; min-width:64px` }, item.identifier),
    el("span", { style: "flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap", title: item.title }, item.title),
    el("span", { style: `${muted}; white-space:nowrap` }, `等待 ${formatWaiting(item.waiting)}`),
  );
}

function askRow(item) {
  const options = parseAskOptions(item.description);
  const reply = el("input", { placeholder: "直接写答案", style: "flex:1; min-width:120px" });
  return el(
    "li",
    { style: "display:grid; gap:4px; padding:6px 0; border-bottom:1px solid var(--border)" },
    row(item, { selectable: false }),
    options.map((option) =>
      el("div", { style: `${muted}; padding-left:72px` }, `${option.letter}. ${option.text}`),
    ),
    el(
      "div",
      { style: "display:flex; gap:6px; padding-left:72px; flex-wrap:wrap" },
      options.map((option) =>
        el("button", { disabled: state.busy, onclick: () => answerAsk(item, option.letter) }, `选 ${option.letter}`),
      ),
      reply,
      el("button", { disabled: state.busy, onclick: () => answerAsk(item, null, reply.value) }, "回复"),
    ),
  );
}

function render() {
  const root = document.getElementById("root");
  const reason = el("input", { placeholder: "不要 / 拒绝的统一理由", style: "min-width:200px", value: state.reason ?? "" });
  reason.oninput = () => (state.reason = reason.value);
  const selectedCount = state.selected.size;

  const toolbar = el(
    "div",
    { style: "display:flex; gap:8px; align-items:center; flex-wrap:wrap; position:sticky; top:0; background:var(--background); padding:8px 0" },
    el("strong", { style: "flex:1" }, "审批队列"),
    el("span", { style: muted }, `已选 ${selectedCount} 条`),
    armed("approve", "同意", () => batchDecision(DECISION_APPROVE, "")),
    reason,
    armed("reject", "不要", () => {
      if (!String(state.reason ?? "").trim()) {
        state.armed = null;
        state.message = "批量不要需要填写统一理由";
        render();
        return;
      }
      batchDecision(DECISION_REJECT, state.reason);
    }),
    el("button", { disabled: state.busy, onclick: () => load() }, "刷新"),
  );

  const sections = [];
  if (state.stale.length) {
    sections.push(
      el(
        "section",
        {},
        el(
          "h3",
          { style: "display:flex; gap:8px; align-items:center" },
          `建议收口（${state.stale.length}）`,
          armed("closeout", "全部发收口评论", () => closeout(state.stale)),
        ),
        el("p", { style: muted }, "这些草稿引用的问课单已停止或已确定。收口评论以 // 开头，只留在看板上，不改状态。"),
        el(
          "ul",
          { style: "list-style:none; margin:0; padding:0" },
          state.stale.map((item) => row({ ...item, title: `${item.title}（${item.order} ${item.ending}）` }, { selectable: false })),
        ),
      ),
    );
  }
  for (const group of state.groups) {
    sections.push(
      el(
        "section",
        {},
        el("h3", {}, `${group.label}（${group.items.length}）`, group.type === CARD_ASK ? el("span", { style: muted }, " 逐条回复，不能批量") : null),
        el(
          "ul",
          { style: "list-style:none; margin:0; padding:0" },
          group.type === CARD_ASK
            ? group.items.map(askRow)
            : group.items.map((item) => row(item, { selectable: group.batch })),
        ),
      ),
    );
  }

  root.replaceChildren(
    el(
      "div",
      { style: "padding:16px; display:grid; gap:12px" },
      toolbar,
      state.message ? el("div", { style: muted }, state.message) : null,
      sections,
    ),
  );
  resize();
}

load().catch((error) => {
  // 403 plugin_extension_disabled: an admin has not switched pages on.
  state.message = `加载失败：${error.message ?? error}`;
  render();
});
