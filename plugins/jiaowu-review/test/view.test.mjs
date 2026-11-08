import assert from "node:assert/strict";
import { test } from "node:test";
import { QUEUE_TABS, cardNumber, displayTitle, failureText, guarded, matchesQuery, rejectLabel, resultToast } from "../ui/view.mjs";

test("tabs run 提案 / 草稿 / 请教 / 其他", () => {
  assert.deepEqual(QUEUE_TABS.map((tab) => tab.label), ["提案", "草稿", "请教", "其他"]);
});

test("the number column reads the protocol number, else the identifier", () => {
  assert.equal(cardNumber({ title: "#924 经验提案：[能力] 缺信息", identifier: "JW-1" }), "#924");
  assert.equal(cardNumber({ title: "D190 待确认：发给 dm:gabby：你好", identifier: "JW-2" }), "D190");
  assert.equal(cardNumber({ title: "Q30 分身请教：D165 怎么办", identifier: "JW-3" }), "Q30");
  assert.equal(cardNumber({ title: "问课单｜2 位导师｜WK-20261101-ABC123", identifier: "JW-4" }), "JW-4");
});

test("the title column drops what the number column and tab already say", () => {
  assert.equal(displayTitle({ title: "#924 经验提案：[能力] 缺信息" }), "缺信息");
  assert.equal(displayTitle({ title: "D190 待确认：发给 dm:gabby：你好" }), "发给 dm:gabby：你好");
  assert.equal(displayTitle({ title: "Q30 分身请教：D165 怎么办" }), "D165 怎么办");
  assert.equal(displayTitle({ title: "问课单｜WK-20261101-ABC123" }), "问课单｜WK-20261101-ABC123");
  assert.equal(displayTitle({ title: "D7 待确认：" }), "D7 待确认：");
});

test("search matches title or identifier, ignoring case and blanks", () => {
  const item = { title: "D190 待确认：发给 dm:Gabby", identifier: "JW-12" };
  assert.ok(matchesQuery(item, ""));
  assert.ok(matchesQuery(item, "  gabby "));
  assert.ok(matchesQuery(item, "d190"));
  assert.ok(matchesQuery(item, "jw-12"));
  assert.ok(!matchesQuery(item, "maddie"));
});

test("the reject button speaks the selection's protocol", () => {
  const draft = { title: "D1 待确认：x" };
  const proposal = { title: "#2 经验提案：y" };
  assert.equal(rejectLabel([draft]), "不要");
  assert.equal(rejectLabel([proposal]), "拒绝");
  assert.equal(rejectLabel([draft, proposal]), "不要 / 拒绝");
});

test("batch results become success, partial or error toasts", () => {
  assert.deepEqual(resultToast("批量同意", 3, []), { kind: "success", title: "批量同意：成功 3 条", details: [], sticky: false });
  const partial = resultToast("批量同意", 2, ["D1 forbidden"]);
  assert.equal(partial.kind, "partial");
  assert.equal(partial.sticky, true);
  assert.deepEqual(partial.details, ["D1 forbidden"]);
  const failed = resultToast("批量不要", 0, ["D1 forbidden", "D2 not_found"]);
  assert.equal(failed.kind, "error");
  assert.equal(failed.sticky, true);
  assert.equal(failed.details.length, 2);
});

test("guarded handlers report sync throws and async rejections instead of escaping", async () => {
  const seen = [];
  const report = (error) => seen.push(error.message);

  assert.doesNotThrow(() => guarded(() => {
    throw new Error("sync");
  }, report)());
  await guarded(async () => {
    throw new Error("async");
  }, report)();
  assert.deepEqual(seen, ["sync", "async"]);

  assert.equal(guarded((a, b) => a + b, report)(2, 3), 5);
  assert.equal(await guarded(async () => "ok", report)(), "ok");
  assert.deepEqual(seen, ["sync", "async"]);
});

test("a failing reporter never turns a guarded failure into an uncaught one", async () => {
  const report = () => {
    throw new Error("reporter broke");
  };
  assert.doesNotThrow(() => guarded(() => {
    throw new Error("sync");
  }, report)());
  await guarded(async () => {
    throw new Error("async");
  }, report)();
});

test("failure text is readable for errors, strings and empty reasons", () => {
  assert.equal(failureText(new Error("403: plugin_extension_disabled")), "403: plugin_extension_disabled");
  assert.equal(failureText("plain"), "plain");
  assert.equal(failureText(undefined), "未知错误");
  assert.equal(failureText(new Error("")), "Error");
});
