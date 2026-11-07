import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARD_ASK,
  CARD_DRAFT,
  CARD_OTHER,
  CARD_PROPOSAL,
  askAnswerComment,
  canBatch,
  classifyCard,
  closeoutComment,
  decisionComment,
  formatWaiting,
  groupQueue,
  isCloseoutComment,
  parseAskOptions,
  planBatch,
  protocolVerbs,
  referencedWenkeId,
  wenkeEnding,
  wenkeOrderId,
} from "../lib/protocol.mjs";

// Footers copied from live cards (2026-11-07).
const DRAFT_FOOTER = "_评论「同意」执行，「改 新内容」修改后执行，「不要 理由」放弃；也可以把卡片拖到「已完成」（=同意）或「已取消」（=不要）。_";
const PROPOSAL_FOOTER = "_评论「同意」写入规范，「修改 新内容」改后写入，「拒绝 理由」放弃；也可以把卡片拖到「已完成」或「已取消」。_";
const ASK_BODY =
  "25ABFF98 缺信息 32 小时 + 已提换导师，这单怎么走？ A. A 由 maddie 按换导师加急接手，本单归档 B. B 继续用本单，批准 D187 催销售补三样 C. C 先按现有信息（多大 BIO120）找候选老师 分身倾向：A 由 maddie 按换导师加急接手，本单归档 问课单：REQ-20261106-25ABFF98 _直接在评论里写答案（有选项时可以只写字母）；把卡片拖到「已取消」表示不回答。_";

test("classifies cards by the title prefix Hermes writes", () => {
  assert.equal(classifyCard("D189 待确认：回复 路觅教育-Sandara（私聊）"), CARD_DRAFT);
  assert.equal(classifyCard("Q35 分身请教：25ABFF98 缺信息 32 小时"), CARD_ASK);
  assert.equal(classifyCard("#924 经验提案：【缺信息】状态需以 missing 非空为前提"), CARD_PROPOSAL);
  assert.equal(classifyCard("【大学】EDUC5387 · 格拉斯哥大学｜3 位导师｜WK-20261105-21C8EB"), CARD_OTHER);
  assert.equal(classifyCard("金沐暘 老师 · 已停止｜EDUC5387"), CARD_OTHER);
  assert.equal(classifyCard("Data cleanup"), CARD_OTHER);
  assert.equal(classifyCard("#12 something else"), CARD_OTHER);
  assert.equal(classifyCard(undefined), CARD_OTHER);
});

test("only drafts and proposals can be batched", () => {
  assert.equal(canBatch(CARD_DRAFT), true);
  assert.equal(canBatch(CARD_PROPOSAL), true);
  assert.equal(canBatch(CARD_ASK), false);
  assert.equal(canBatch(CARD_OTHER), false);
});

test("reads the verbs from the card's own footer", () => {
  assert.deepEqual(protocolVerbs(CARD_DRAFT, DRAFT_FOOTER), { approve: "同意", revise: "改", reject: "不要" });
  assert.deepEqual(protocolVerbs(CARD_PROPOSAL, PROPOSAL_FOOTER), { approve: "同意", revise: "修改", reject: "拒绝" });
  // A footer with other verbs wins over the type default.
  assert.deepEqual(protocolVerbs(CARD_DRAFT, PROPOSAL_FOOTER), { approve: "同意", revise: "修改", reject: "拒绝" });
  // No body: fall back to the type default.
  assert.deepEqual(protocolVerbs(CARD_PROPOSAL, ""), { approve: "同意", revise: "修改", reject: "拒绝" });
  assert.equal(protocolVerbs(CARD_ASK, ASK_BODY), null);
});

test("maps each decision to exactly the protocol comment", () => {
  assert.deepEqual(decisionComment(CARD_DRAFT, DRAFT_FOOTER, "approve", "ignored"), { content: "同意" });
  assert.deepEqual(decisionComment(CARD_DRAFT, DRAFT_FOOTER, "revise", "  老师好，改成周三  "), { content: "改 老师好，改成周三" });
  assert.deepEqual(decisionComment(CARD_DRAFT, DRAFT_FOOTER, "reject", "学生已取消"), { content: "不要 学生已取消" });
  assert.deepEqual(decisionComment(CARD_PROPOSAL, PROPOSAL_FOOTER, "approve", ""), { content: "同意" });
  assert.deepEqual(decisionComment(CARD_PROPOSAL, PROPOSAL_FOOTER, "revise", "只适用于大学单"), { content: "修改 只适用于大学单" });
  assert.deepEqual(decisionComment(CARD_PROPOSAL, PROPOSAL_FOOTER, "reject", "已有同类规范"), { content: "拒绝 已有同类规范" });
});

test("revise and reject require text; asks and unknown buttons are refused", () => {
  assert.ok(decisionComment(CARD_DRAFT, DRAFT_FOOTER, "revise", " ").error);
  assert.ok(decisionComment(CARD_DRAFT, DRAFT_FOOTER, "reject", "").error);
  assert.ok(decisionComment(CARD_DRAFT, DRAFT_FOOTER, "delete", "x").error);
  assert.ok(decisionComment(CARD_ASK, ASK_BODY, "approve", "").error);
  assert.ok(decisionComment(CARD_OTHER, "", "approve", "").error);
});

test("parses ask options in order and answers with the bare letter", () => {
  const options = parseAskOptions(ASK_BODY);
  assert.deepEqual(options.map((option) => option.letter), ["A", "B", "C"]);
  assert.equal(options[0].text, "由 maddie 按换导师加急接手，本单归档");
  assert.equal(options[2].text, "先按现有信息（多大 BIO120）找候选老师");
  assert.deepEqual(askAnswerComment(ASK_BODY, "b"), { content: "B" });
  assert.match(askAnswerComment(ASK_BODY, "D").error, /没有选项 D/);
  assert.match(askAnswerComment("没有选项的请教", "A").error, /没有选项/);
});

test("ask options must start at A and run in sequence", () => {
  assert.deepEqual(parseAskOptions("先看 B. 这一段 再说").map((o) => o.letter), []);
  const four = "怎么走？ A. A 一 B. B 二 C. C 三 D. D 四 分身倾向：A 一";
  assert.deepEqual(parseAskOptions(four).map((o) => o.letter), ["A", "B", "C", "D"]);
});

test("recognises 问课单 and the drafts that reference one", () => {
  assert.equal(wenkeOrderId("【大学】MKTG6033 数字营销 · 香港中文大学｜16 位导师 · 1 可接｜WK-20261106-397B60"), "WK-20261106-397B60");
  assert.equal(wenkeOrderId("D158 待确认：问课确定导师 WK-20261106-397B60 裴浩博"), null);
  assert.equal(referencedWenkeId("D158 待确认：问课确定导师 WK-20261106-397B60 裴浩博", ""), "WK-20261106-397B60");
  assert.equal(referencedWenkeId("D94 待确认：发给 dm:DongFan：宝", "问课单：WK-20261105-21C8EB _评论…"), "WK-20261105-21C8EB");
  assert.equal(referencedWenkeId("D188 待确认：发给 dm:gabby", "问课单：REQ-20261105-B37C1422"), null);
  // The order itself does not reference itself.
  assert.equal(referencedWenkeId("计算机 · 南京大学｜1 位导师｜WK-20261020-784922", ""), null);
});

test("only cancelled (停止) and done (确定) end a 问课单", () => {
  assert.equal(wenkeEnding("cancelled"), "已停止");
  assert.equal(wenkeEnding("done"), "已确定");
  for (const status of ["in_review", "in_progress", "todo", "backlog", "blocked"]) assert.equal(wenkeEnding(status), null);
});

test("closeout comment stays on the board and is recognisable", () => {
  const text = closeoutComment("WK-20261105-21C8EB", "已停止");
  assert.ok(text.startsWith("//"));
  assert.match(text, /WK-20261105-21C8EB 已停止，此卡建议作废/);
  assert.ok(isCloseoutComment(text));
  assert.ok(!isCloseoutComment("同意"));
});

test("groups the queue and sorts by longest wait", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const groups = groupQueue(
    [
      { id: "1", title: "D1 待确认：a", created_at: "2026-11-07T11:00:00Z" },
      { id: "2", title: "D2 待确认：b", created_at: "2026-11-04T11:00:00Z" },
      { id: "3", title: "Q1 分身请教：c", created_at: "2026-11-06T11:00:00Z" },
      { id: "4", title: "#9 经验提案：d", created_at: "2026-11-05T12:00:00Z" },
      { id: "5", title: "问课单｜WK-20261106-397B60", created_at: "2026-11-06T12:00:00Z" },
    ],
    now,
  );
  assert.deepEqual(groups.map((group) => [group.label, group.batch, group.items.map((item) => item.id)]), [
    ["草稿", true, ["2", "1"]],
    ["请教", false, ["3"]],
    ["经验提案", true, ["4"]],
    ["其他", false, ["5"]],
  ]);
  assert.equal(groups[0].items[0].waiting, 3 * 24 * 60 + 60);
  assert.equal(formatWaiting(groups[0].items[0].waiting), "3 天 1 小时");
  assert.equal(formatWaiting(59), "59 分钟");
  assert.equal(formatWaiting(120), "2 小时");
  assert.equal(formatWaiting(48 * 60), "2 天");
});

test("batch plan splits by comment and refuses asks", () => {
  const selected = [
    { id: "d1", title: "D1 待确认：a", description: DRAFT_FOOTER },
    { id: "d2", title: "D2 待确认：b", description: "" },
    { id: "p1", title: "#7 经验提案：c", description: PROPOSAL_FOOTER },
    { id: "q1", title: "Q3 分身请教：d", description: ASK_BODY },
  ];
  const reject = planBatch(selected, "reject", "统一理由");
  assert.deepEqual(reject.calls, [
    { content: "不要 统一理由", issue_ids: ["d1", "d2"] },
    { content: "拒绝 统一理由", issue_ids: ["p1"] },
  ]);
  assert.deepEqual(reject.refused.map((item) => item.issue_id), ["q1"]);

  const approve = planBatch(selected, "approve", "");
  assert.deepEqual(approve.calls, [{ content: "同意", issue_ids: ["d1", "d2", "p1"] }]);

  const missingReason = planBatch(selected.slice(0, 1), "reject", "  ");
  assert.deepEqual(missingReason.calls, []);
  assert.equal(missingReason.refused.length, 1);
});
