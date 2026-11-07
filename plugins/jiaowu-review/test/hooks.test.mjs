import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cardDecision } from "../lib/card.mjs";
import { KEY_CARD, KEY_PENDING, recordEvent, sweep } from "../lib/closeout.mjs";
import { createVerifier, handleHook } from "../server/app.mjs";

const DRAFT = {
  id: "d1",
  title: "D158 待确认：问课确定导师 WK-20261106-397B60 裴浩博",
  description: "内容 _评论「同意」执行，「改 新内容」修改后执行，「不要 理由」放弃。_",
  status: "in_review",
  created_at: "2026-11-06T09:00:00Z",
};
const PROPOSAL = {
  id: "p1",
  title: "#924 经验提案：【缺信息】状态需以 missing 非空为前提",
  description: "_评论「同意」写入规范，「修改 新内容」改后写入，「拒绝 理由」放弃。_",
  status: "in_review",
};
const ASK = {
  id: "q1",
  title: "Q35 分身请教：25ABFF98 怎么走？",
  description: "怎么走？ A. A 接手 B. B 继续 C. C 找老师 分身倾向：A 接手",
  status: "in_review",
};
const ORDER = {
  id: "o1",
  title: "【大学】MKTG6033 数字营销 · 香港中文大学｜16 位导师 · 1 可接｜WK-20261106-397B60",
  status: "in_review",
};

// ---- card buttons ---------------------------------------------------------

test("card buttons map to the protocol comment as the clicker", () => {
  assert.deepEqual(cardDecision({ rule: "draft", button: "approve", input: "" }, DRAFT), {
    effects: [{ type: "comment", content: "同意" }],
    status_text: "已同意",
  });
  assert.deepEqual(cardDecision({ rule: "draft", button: "revise", input: "改成周三" }, DRAFT).effects, [
    { type: "comment", content: "改 改成周三" },
  ]);
  assert.deepEqual(cardDecision({ rule: "draft", button: "reject", input: "学生取消" }, DRAFT).effects, [
    { type: "comment", content: "不要 学生取消" },
  ]);
  assert.deepEqual(cardDecision({ rule: "proposal", button: "reject", input: "重复" }, PROPOSAL).effects, [
    { type: "comment", content: "拒绝 重复" },
  ]);
  assert.deepEqual(cardDecision({ rule: "proposal", button: "revise", input: "限大学单" }, PROPOSAL).effects, [
    { type: "comment", content: "修改 限大学单" },
  ]);
  assert.deepEqual(cardDecision({ rule: "ask", button: "b", input: "typed but ignored" }, ASK), {
    effects: [{ type: "comment", content: "B" }],
    status_text: "已选 B",
  });
  assert.deepEqual(cardDecision({ rule: "ask", button: "reply", input: "先挂着" }, ASK).effects, [
    { type: "comment", content: "先挂着" },
  ]);
});

test("card clicks that do not fit the card are refused, never guessed", () => {
  assert.ok(cardDecision({ rule: "ask", button: "D", input: "" }, ASK).error, "no option D on this ask");
  assert.ok(cardDecision({ rule: "ask", button: "reply", input: " " }, ASK).error);
  assert.ok(cardDecision({ rule: "draft", button: "revise", input: "" }, DRAFT).error);
  assert.ok(cardDecision({ rule: "draft", button: "approve" }, { ...DRAFT, status: "done" }).error, "already closed");
  assert.ok(cardDecision({ rule: "draft", button: "approve" }, PROPOSAL).error, "rule/type mismatch");
  assert.ok(cardDecision({ rule: "nope", button: "approve" }, DRAFT).error);
  assert.ok(cardDecision({ rule: "draft", button: "approve" }, null).error);
});

// ---- closeout -------------------------------------------------------------

function memoryStore() {
  const map = new Map();
  return {
    map,
    keys: async () => [...map.keys()],
    get: async (key) => map.get(key) ?? null,
    put: async (key, value) => void map.set(key, String(value)),
    delete: async (key) => void map.delete(key),
  };
}

function fakeMultica(issues) {
  const comments = new Map();
  return {
    comments,
    getIssue: async (id) => issues.get(id) ?? null,
    listComments: async (id) => comments.get(id) ?? [],
    comment: async (id, content) => {
      comments.set(id, [...(comments.get(id) ?? []), { content }]);
    },
  };
}

test("closeout: a stopped 问课单 leaves one // comment on each waiting draft and tutor card", async () => {
  const store = memoryStore();
  const tutor = { id: "t1", title: "裴浩博 老师 · 追问中｜MKTG6033", parent_issue_id: "o1", status: "in_review", created_at: "2026-11-06T08:00:00Z" };
  const answered = { ...DRAFT, id: "d2", title: "D152 待确认：问课 WK-20261106-397B60 发给 裴浩博 老师" };
  const ask = { ...ASK, id: "q2", title: "Q33 分身请教：WK-20261106-397B60 整单已停止，怎么走？" };

  await recordEvent("issue.created", ORDER, store);
  await recordEvent("issue.created", DRAFT, store);
  await recordEvent("issue.created", answered, store);
  await recordEvent("issue.created", tutor, store);
  assert.deepEqual(await recordEvent("issue.created", ask, store), { skipped: "not linked to a 问课单" });
  // d2 gets answered before the order ends: released.
  await recordEvent("issue.status_changed", { ...answered, status: "done" }, store);
  assert.ok(!store.map.has(`${KEY_CARD}WK-20261106-397B60:d2`));

  const stopped = { ...ORDER, status: "cancelled", updated_at: "2026-11-07T10:00:00Z" };
  assert.deepEqual(await recordEvent("issue.status_changed", stopped, store), { order: "WK-20261106-397B60", ending: "已停止" });

  const lateDraft = { ...DRAFT, id: "d3", created_at: "2026-11-07T11:00:00Z" };
  await recordEvent("issue.created", lateDraft, store);

  const multica = fakeMultica(new Map([["o1", stopped], ["d1", DRAFT], ["t1", tutor], ["d3", lateDraft]]));
  const report = await sweep(store, multica);
  assert.deepEqual(report.commented.sort(), ["d1", "t1"]);
  assert.equal(multica.comments.get("d1")[0].content, "// 问课单 WK-20261106-397B60 已停止，此卡建议作废（审批插件自动标记，未改状态）");
  assert.ok(!multica.comments.has("d3"), "a card written after the order ended is left alone");
  assert.deepEqual([...store.map.keys()], [], "every key is released once used");

  // A second run (or a retry) does nothing.
  const again = await sweep(store, multica);
  assert.deepEqual(again, { orders: 0, commented: [], skipped: [], failed: [] });
});

test("closeout: 问课确定 closes out too, 问课重开 does not, and an existing mark is not repeated", async () => {
  const store = memoryStore();
  await recordEvent("issue.created", ORDER, store);
  await recordEvent("issue.created", DRAFT, store);
  await recordEvent("issue.status_changed", { ...ORDER, status: "done" }, store);

  // Reopened before the sweep ran.
  const reopened = fakeMultica(new Map([["o1", ORDER], ["d1", DRAFT]]));
  const first = await sweep(store, reopened);
  assert.deepEqual(first.skipped, [{ order: "WK-20261106-397B60", reason: "reopened" }]);
  assert.ok(store.map.has(`${KEY_CARD}WK-20261106-397B60:d1`), "cards stay recorded for a later ending");

  await recordEvent("issue.status_changed", { ...ORDER, status: "done" }, store);
  const confirmed = fakeMultica(new Map([["o1", { ...ORDER, status: "done" }], ["d1", DRAFT]]));
  confirmed.comments.set("d1", [{ content: "// 问课单 WK-20261106-397B60 已确定，此卡建议作废（审批插件自动标记，未改状态）" }]);
  const second = await sweep(store, confirmed);
  assert.deepEqual(second.commented, []);
  assert.equal(confirmed.comments.get("d1").length, 1);
});

test("closeout: a failed write keeps the order pending for the next run", async () => {
  const store = memoryStore();
  await recordEvent("issue.created", ORDER, store);
  await recordEvent("issue.created", DRAFT, store);
  await recordEvent("issue.status_changed", { ...ORDER, status: "cancelled" }, store);
  const broken = fakeMultica(new Map([["o1", { ...ORDER, status: "cancelled" }], ["d1", DRAFT]]));
  broken.comment = async () => {
    throw new Error("503");
  };
  const report = await sweep(store, broken);
  assert.equal(report.failed.length, 1);
  assert.ok(store.map.has(`${KEY_PENDING}WK-20261106-397B60`));
});

// ---- hook server ----------------------------------------------------------

test("verifier accepts a signed request once and refuses replays, stale and forged ones", () => {
  const secret = "ab".repeat(32);
  const now = 1_800_000_000_000;
  const verify = createVerifier(`whsec_${secret}`, () => now);
  const raw = Buffer.from('{"trigger":"card_action"}');
  const timestamp = String(now / 1000);
  const signature = createHmac("sha256", Buffer.from(secret, "hex")).update(`${timestamp}.`).update(raw).digest("hex");
  const headers = { "x-multica-timestamp": timestamp, "x-multica-signature": `v1=${signature}` };
  assert.equal(verify(raw, headers), null);
  assert.equal(verify(raw, headers), "replayed request");
  assert.equal(verify(Buffer.from("{}"), { ...headers, "x-multica-signature": `v1=${"0".repeat(64)}` }), "signature does not match");
  assert.match(verify(raw, { ...headers, "x-multica-timestamp": String(now / 1000 - 301) }), /window/);
  assert.equal(verify(raw, {}), "missing signature");
});

test("hook routes: card answers 422 on a refused click so the card stays open", async () => {
  const client = () => ({ getIssue: async () => ASK, store: memoryStore() });
  const ok = await handleHook("/hooks/card", { trigger: "card_action", issue_id: "q1", input: { rule: "ask", button: "a" } }, client);
  assert.deepEqual(ok, [200, { effects: [{ type: "comment", content: "A" }], status_text: "已选 A" }]);
  const refused = await handleHook("/hooks/card", { trigger: "card_action", issue_id: "q1", input: { rule: "ask", button: "D" } }, client);
  assert.equal(refused[0], 422);
  const wrong = await handleHook("/hooks/card", { trigger: "schedule" }, client);
  assert.equal(wrong[0], 404);
});

test("hook routes: track reads the issue from the event payload", async () => {
  const store = memoryStore();
  const client = () => ({ getIssue: async () => null, store });
  const [status, result] = await handleHook(
    "/hooks/track",
    { trigger: "event", event_type: "issue.created", input: { issue: ORDER } },
    client,
  );
  assert.equal(status, 200);
  assert.deepEqual(result, { order: "WK-20261106-397B60" });
  assert.equal(store.map.get("wk:WK-20261106-397B60"), "o1");
});

// ---- manifest ------------------------------------------------------------

test("manifest buttons line up with what the hook understands", () => {
  const manifest = JSON.parse(readFileSync(new URL("../multica.plugin.json", import.meta.url), "utf8"));
  const rules = Object.fromEntries(manifest.contributes.card_buttons.map((rule) => [rule.key, rule]));
  assert.deepEqual(Object.keys(rules).sort(), ["ask", "draft", "proposal"]);
  assert.deepEqual(rules.draft.buttons.map((b) => b.key), ["approve", "revise", "reject"]);
  assert.deepEqual(rules.proposal.buttons.map((b) => [b.key, b.label]), [["approve", "同意"], ["revise", "修改"], ["reject", "拒绝"]]);
  assert.deepEqual(rules.ask.buttons.map((b) => b.key), ["a", "b", "c", "d", "reply"]);
  // Least privilege: the plugin never changes a status.
  assert.ok(!manifest.scopes.includes("issues:write"));
});
