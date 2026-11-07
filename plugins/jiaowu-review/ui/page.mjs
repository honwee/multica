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
  CARD_PROPOSAL,
  DECISION_APPROVE,
  DECISION_REJECT,
  askAnswerComment,
  classifyCard,
  closeoutComment,
  draftDecisionLine,
  draftNumber,
  filterProposals,
  findSupersededDrafts,
  formatWaiting,
  groupProposals,
  groupQueue,
  parseAskOptions,
  parseProposal,
  planBatch,
  proposalTags,
  referencedDrafts,
  referencedWenkeId,
  supersededReason,
  truncateText,
  wenkeEnding,
  wenkeOrderId,
} from "../lib/protocol.mjs";

const BATCH_LIMIT = 100;
const PAGE_LIMIT = 200;
const DETAIL_CONCURRENCY = 8;

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
  // 经验提案
  tagFilter: new Set(),
  query: "",
  openGroups: new Set(),
  expanded: new Set(),
  // 草稿
  superseded: [],
  supersededOff: new Set(),
  olderCount: new Map(),
  // 请教 ↔ 草稿
  askLinks: new Map(),
  citedBy: new Map(),
};

const STATUS_TEXT = { in_review: "等待中", done: "已完成", cancelled: "已取消", in_progress: "进行中" };

async function load() {
  state.message = "加载中…";
  render();
  const [waiting, cancelled, done, inProgress] = await Promise.all([
    listAll("in_review"),
    listAll("cancelled"),
    listAll("done"),
    listAll("in_progress"),
  ]);

  const orders = new Map();
  for (const issue of [...waiting, ...cancelled, ...done]) {
    const order = wenkeOrderId(issue.title);
    if (order) orders.set(order, issue);
  }

  // Bodies: drafts for the 问课单 reference and the recipient, asks for their
  // options, proposals for the changed file. A body that fails to load leaves
  // the card ungrouped rather than failing the page.
  const needBody = waiting.filter((issue) => classifyCard(issue.title) !== "other");
  let loaded = 0;
  const bodies = await mapLimited(needBody, DETAIL_CONCURRENCY, async (issue) => {
    const detail = await call("GET", `/issues/${issue.id}`);
    if (++loaded % 50 === 0) {
      state.message = `加载正文 ${loaded}/${needBody.length}…`;
      render();
    }
    return detail;
  });
  state.details = new Map(bodies.filter(Boolean).map((issue) => [issue.id, issue]));

  const now = Date.now();
  state.groups = groupQueue(
    waiting.map((issue) => {
      const description = state.details.get(issue.id)?.description ?? "";
      const item = { ...issue, description };
      if (classifyCard(issue.title) === CARD_PROPOSAL) item.proposal = parseProposal(issue.title, description);
      return item;
    }),
    now,
  );
  const drafts = state.groups.find((group) => group.type === CARD_DRAFT).items;

  state.stale = [];
  for (const item of drafts) {
    const order = referencedWenkeId(item.title, item.description);
    const orderIssue = order ? orders.get(order) : null;
    const ending = orderIssue ? wenkeEnding(orderIssue.status) : null;
    if (!ending) continue;
    if (Date.parse(item.created_at) > Date.parse(orderIssue.updated_at)) continue;
    state.stale.push({ ...item, order, ending });
  }

  const { current, superseded } = findSupersededDrafts(drafts);
  state.superseded = superseded;
  state.supersededOff.clear();
  state.olderCount = new Map([...current].map(([id, older]) => [id, older.length]));

  await linkAsks(drafts, [...done, ...cancelled, ...inProgress]);

  state.selected.clear();
  state.message = "";
  render();
}

// Each ask lists the drafts it names; drafts that already left the queue get
// their decision comment read so the ask shows what was decided.
async function linkAsks(waitingDrafts, otherIssues) {
  const byNumber = new Map();
  for (const issue of [...otherIssues, ...waitingDrafts]) {
    const number = draftNumber(issue.title);
    const known = number ? byNumber.get(number) : null;
    if (number && (!known || Date.parse(issue.created_at) >= Date.parse(known.created_at))) byNumber.set(number, issue);
  }
  state.askLinks = new Map();
  state.citedBy = new Map();
  const decided = new Map();
  for (const ask of state.groups.find((group) => group.type === CARD_ASK).items) {
    const askNumber = ask.title.match(/^(Q\d+)/)?.[1] ?? ask.identifier;
    const links = referencedDrafts(ask.title, ask.description).map((number) => {
      const draft = byNumber.get(number) ?? null;
      if (draft) {
        state.citedBy.set(draft.id, [...(state.citedBy.get(draft.id) ?? []), askNumber]);
        if (draft.status !== "in_review") decided.set(draft.id, draft);
      }
      return { number, draft };
    });
    if (links.length) state.askLinks.set(ask.id, links);
  }
  const ids = [...decided.keys()];
  const answers = await mapLimited(ids, DETAIL_CONCURRENCY, async (id) => {
    const [detail, list] = await Promise.all([call("GET", `/issues/${id}`), call("GET", `/issues/${id}/comments`)]);
    return draftDecisionLine(list?.comments ?? [], detail?.description ?? "");
  });
  const decision = new Map(ids.map((id, index) => [id, answers[index]]));
  for (const links of state.askLinks.values()) {
    for (const link of links) if (link.draft) link.decision = decision.get(link.draft.id) ?? null;
  }
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

// One reject per kept draft: the reason names the draft that replaced them.
function rejectSuperseded(entries) {
  return run("作废旧版本", async () => {
    const byKept = new Map();
    for (const { item, kept } of entries) {
      if (!byKept.has(kept.id)) byKept.set(kept.id, { kept, items: [] });
      byKept.get(kept.id).items.push(item);
    }
    const results = [];
    const refused = [];
    for (const { kept, items } of byKept.values()) {
      const plan = planBatch(items, DECISION_REJECT, supersededReason(kept));
      refused.push(...plan.refused);
      for (const { content, issue_ids } of plan.calls) results.push(...(await postBatch(issue_ids, content)));
    }
    return summarize(results, refused);
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

function checkbox(checked, onchange) {
  return el("input", { type: "checkbox", checked, disabled: state.busy, onchange: (event) => onchange(event.target.checked) });
}

function select(items, on) {
  for (const item of items) {
    if (on) state.selected.set(item.id, item);
    else state.selected.delete(item.id);
  }
  render();
}

function jumpTo(id) {
  const target = document.getElementById(`row-${id}`);
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  target.style.background = "var(--accent)";
  setTimeout(() => (target.style.background = ""), 1500);
}

function row(item, { selectable, marks = [], anchor = true }) {
  const box = selectable ? checkbox(state.selected.has(item.id), (on) => select([item], on)) : null;
  return el(
    "li",
    { id: anchor ? `row-${item.id}` : "", style: "display:flex; gap:8px; align-items:baseline; padding:4px 0" },
    box,
    el("span", { style: `${muted}; min-width:64px` }, item.identifier),
    el("span", { style: "flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap", title: item.title }, item.title),
    marks.map((mark) => el("span", { style: `${muted}; white-space:nowrap; font-size:var(--text-xs, 12px)` }, mark)),
    el("span", { style: `${muted}; white-space:nowrap` }, `等待 ${formatWaiting(item.waiting)}`),
  );
}

function draftMarks(item) {
  const marks = [];
  const older = state.olderCount.get(item.id);
  if (older) marks.push(`另有 ${older} 条旧版本`);
  const cited = state.citedBy.get(item.id);
  if (cited) marks.push(`被 ${cited.join("、")} 引用`);
  return marks;
}

function draftLinks(item) {
  const links = state.askLinks.get(item.id);
  if (!links) return null;
  return el(
    "div",
    { style: "display:grid; gap:2px; padding-left:72px" },
    links.map(({ number, draft, decision }) => {
      if (!draft) return el("div", { style: muted }, `引用 ${number}：未找到这条草稿`);
      const waiting = draft.status === "in_review";
      const label = el(
        waiting ? "a" : "span",
        waiting ? { href: "#", onclick: (event) => (event.preventDefault(), jumpTo(draft.id)) } : {},
        number,
      );
      return el(
        "div",
        { style: muted },
        "引用 ",
        label,
        ` · ${STATUS_TEXT[draft.status] ?? draft.status_name ?? draft.status} · ${truncateText(draft.title, 80)}`,
        decision ? ` · 决策：${decision}` : null,
      );
    }),
  );
}

function proposalRow(item) {
  const info = item.proposal ?? {};
  const open = state.expanded.has(item.id);
  const toggle = el(
    "button",
    {
      style: "font-size:var(--text-xs, 12px)",
      onclick: () => {
        if (open) state.expanded.delete(item.id);
        else state.expanded.add(item.id);
        render();
      },
    },
    open ? "收起" : "理由 / 依据",
  );
  return el(
    "li",
    { style: "display:grid; gap:2px; padding:2px 0" },
    row(item, { selectable: true, marks: [info.tag ? `[${info.tag}]` : null, info.change].filter(Boolean) }),
    el("div", { style: "padding-left:96px; display:flex; gap:8px; align-items:baseline" }, toggle,
      open ? null : el("span", { style: `${muted}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap` }, info.reason ? `理由：${truncateText(info.reason, 60)}` : "")),
    open
      ? el(
          "div",
          { style: "padding-left:96px; display:grid; gap:4px" },
          info.reason ? el("div", {}, `理由：${info.reason}`) : null,
          info.basis ? el("div", {}, `依据：${info.basis}`) : null,
          el("pre", { style: `${muted}; white-space:pre-wrap; margin:0; font:inherit` }, item.description || "（正文未加载）"),
        )
      : null,
  );
}

function proposalSection(group) {
  const tags = proposalTags(group.items);
  const visible = filterProposals(group.items, { tags: state.tagFilter, query: state.query });
  const allOn = visible.length > 0 && visible.every((item) => state.selected.has(item.id));
  const search = el("input", { placeholder: "搜索标题", value: state.query, style: "min-width:160px" });
  search.onchange = () => {
    state.query = search.value;
    render();
  };
  const chips = tags.map(({ tag, count }) => {
    const on = state.tagFilter.has(tag);
    return el(
      "button",
      {
        style: on ? "background:var(--primary); color:var(--primary-foreground)" : "",
        onclick: () => {
          if (on) state.tagFilter.delete(tag);
          else state.tagFilter.add(tag);
          render();
        },
      },
      `[${tag}] ${count}`,
    );
  });
  const filters = el(
    "div",
    { style: "display:flex; gap:6px; align-items:center; flex-wrap:wrap" },
    checkbox(allOn, (on) => select(visible, on)),
    el("span", { style: muted }, `筛选结果 ${visible.length} 条`),
    chips,
    search,
  );
  const groups = groupProposals(visible).map(({ path, items }) => {
    const open = state.openGroups.has(path);
    const groupOn = items.every((item) => state.selected.has(item.id));
    return el(
      "li",
      { style: "padding:4px 0; border-bottom:1px solid var(--border)" },
      el(
        "div",
        { style: "display:flex; gap:8px; align-items:center" },
        checkbox(groupOn, (on) => select(items, on)),
        el(
          "button",
          {
            style: "flex:1; text-align:left; background:none; border:none; padding:0; cursor:pointer; color:inherit",
            onclick: () => {
              if (open) state.openGroups.delete(path);
              else state.openGroups.add(path);
              render();
            },
          },
          `${open ? "▾" : "▸"} ${path}`,
        ),
        el("span", { style: muted }, `${items.length} 条`),
      ),
      open ? el("ul", { style: "list-style:none; margin:0; padding:0 0 0 24px" }, items.map(proposalRow)) : null,
    );
  });
  return el(
    "section",
    {},
    el("h3", {}, `${group.label}（${group.items.length}）`),
    filters,
    el("ul", { style: "list-style:none; margin:0; padding:0" }, groups),
  );
}

function draftSection(group) {
  const supersededIds = new Set(state.superseded.map(({ item }) => item.id));
  const current = group.items.filter((item) => !supersededIds.has(item.id));
  const chosen = state.superseded.filter(({ item }) => !state.supersededOff.has(item.id));
  const sub = state.superseded.length
    ? el(
        "div",
        { style: "padding:8px 0 0 16px" },
        el(
          "h4",
          { style: "display:flex; gap:8px; align-items:center; margin:0" },
          `疑似被覆盖（${state.superseded.length}）`,
          armed("superseded", `作废选中的 ${chosen.length} 条`, () => rejectSuperseded(chosen)),
        ),
        el("p", { style: `${muted}; margin:4px 0` }, "同一收件人、同一 REQ/WK 单号（或 10 分钟内）的旧版本。发出「不要 已被新草稿 Dxxx 替代」。"),
        el(
          "ul",
          { style: "list-style:none; margin:0; padding:0" },
          state.superseded.map(({ item, kept }) =>
            el(
              "li",
              { style: "display:flex; gap:8px; align-items:baseline" },
              checkbox(!state.supersededOff.has(item.id), (on) => {
                if (on) state.supersededOff.delete(item.id);
                else state.supersededOff.add(item.id);
                render();
              }),
              el("div", { style: "flex:1; min-width:0" }, row(item, { selectable: false, marks: [`→ ${draftNumber(kept.title) ?? kept.identifier}`] })),
            ),
          ),
        ),
      )
    : null;
  return el(
    "section",
    {},
    el("h3", {}, `${group.label}（${group.items.length}）`),
    el("ul", { style: "list-style:none; margin:0; padding:0" }, current.map((item) => row(item, { selectable: true, marks: draftMarks(item) }))),
    sub,
  );
}

function askRow(item) {
  const options = parseAskOptions(item.description);
  const reply = el("input", { placeholder: "直接写答案", style: "flex:1; min-width:120px" });
  return el(
    "li",
    { id: `row-${item.id}`, style: "display:grid; gap:4px; padding:6px 0; border-bottom:1px solid var(--border)" },
    row(item, { selectable: false, anchor: false }),
    draftLinks(item),
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
    armed("reject", "不要 / 拒绝", () => {
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
          state.stale.map((item) => row({ ...item, title: `${item.title}（${item.order} ${item.ending}）` }, { selectable: false, anchor: false })),
        ),
      ),
    );
  }
  for (const group of state.groups) {
    if (group.type === CARD_DRAFT) {
      sections.push(draftSection(group));
      continue;
    }
    if (group.type === CARD_PROPOSAL) {
      sections.push(proposalSection(group));
      continue;
    }
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
