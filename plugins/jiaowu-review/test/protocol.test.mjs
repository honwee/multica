import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARD_ASK,
  CARD_DRAFT,
  CARD_OTHER,
  CARD_PROPOSAL,
  UNGROUPED,
  askAnswerComment,
  canBatch,
  classifyCard,
  closeoutComment,
  decisionComment,
  draftDecisionLine,
  draftNumber,
  draftRecipient,
  draftReference,
  filterProposals,
  findSupersededDrafts,
  formatWaiting,
  groupProposals,
  groupQueue,
  isCloseoutComment,
  parseAskOptions,
  parseProposal,
  planBatch,
  proposalTags,
  protocolVerbs,
  referencedDrafts,
  referencedWenkeId,
  supersededReason,
  truncateText,
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

// ---- 1.0.2: proposals, superseded drafts, asks → drafts ---------------------

const PROPOSAL_924 = [
  "#924 [能力] 【缺信息】状态需以 missing 非空为前提，不得仅凭字段缺省判定",
  "    改动：capabilities/intake-review/capability.md（追加）",
  "    内容：判定【缺信息】前先检查 missing 列表非空",
  "    理由：Q35 里 25ABFF98 被误判缺信息 32 小时",
  "    依据：REQ-20261106-25ABFF98 的处理记录",
  PROPOSAL_FOOTER,
].join("\n");

test("parses a proposal body: tag, changed file, reason and basis", () => {
  assert.deepEqual(parseProposal("#924 经验提案：【缺信息】状态需以 missing 非空为前提", PROPOSAL_924), {
    tag: "能力",
    path: "capabilities/intake-review/capability.md",
    change: "追加",
    content: "判定【缺信息】前先检查 missing 列表非空",
    reason: "Q35 里 25ABFF98 被误判缺信息 32 小时",
    basis: "REQ-20261106-25ABFF98 的处理记录",
  });
  // A tag in the title wins; a flattened body still splits on the labels.
  const flat = parseProposal("#930 [规则] 经验提案：x", "#930 改动：rules/sales.md（修改） 内容：a 理由：b 依据：c _评论「同意」写入规范_");
  assert.equal(flat.tag, "规则");
  assert.equal(flat.path, "rules/sales.md");
  assert.equal(flat.change, "修改");
  assert.equal(flat.reason, "b");
  assert.equal(flat.basis, "c");
  // No body: nothing to group by.
  assert.deepEqual(parseProposal("#931 经验提案：y", ""), { tag: null, path: null, change: null, content: null, reason: null, basis: null });
});

test("groups proposals by changed file, filters by tag and title", () => {
  const items = [
    { id: "p1", title: "#924 经验提案：缺信息", description: PROPOSAL_924 },
    { id: "p2", title: "#925 经验提案：缺信息 2", description: PROPOSAL_924.replace("[能力]", "[规则]") },
    { id: "p3", title: "#926 经验提案：报价", description: "#926 [规则] x\n改动：rules/price.md（追加）" },
    { id: "p4", title: "#927 经验提案：无正文", description: "" },
  ].map((item) => ({ ...item, proposal: parseProposal(item.title, item.description) }));
  const groups = groupProposals(items);
  assert.deepEqual(groups.map((group) => [group.path, group.items.map((item) => item.id)]), [
    ["capabilities/intake-review/capability.md", ["p1", "p2"]],
    ["rules/price.md", ["p3"]],
    [UNGROUPED, ["p4"]],
  ]);
  assert.deepEqual(proposalTags(items), [{ tag: "规则", count: 2 }, { tag: "能力", count: 1 }]);
  assert.deepEqual(filterProposals(items, { tags: new Set(["规则"]) }).map((item) => item.id), ["p2", "p3"]);
  assert.deepEqual(filterProposals(items, { query: "报价" }).map((item) => item.id), ["p3"]);
  assert.deepEqual(filterProposals(items, { tags: new Set(), query: " " }).length, 4);
});

test("reads a draft's recipient and order reference from the title", () => {
  const d190 = "D190 待确认：发给 dm:gabby：REQ-20261105-B37C1422（诺丁汉宁波 ECONF003）现在只缺一个信息…";
  assert.deepEqual(draftRecipient(d190), { key: "dm:gabby", explicit: true });
  assert.deepEqual(draftRecipient("D181 待确认：回复 Lumist.Grace（私聊）"), { key: "dm:Lumist.Grace", explicit: true });
  assert.deepEqual(draftRecipient("D183 待确认：发给 当前会话：宝，BIO120 这单…"), { key: "当前会话", explicit: false });
  assert.equal(draftRecipient("D158 待确认：问课确定导师 WK-20261106-397B60 裴浩博"), null);
  assert.equal(draftReference(d190, ""), "REQ-20261105-B37C1422");
  assert.equal(draftReference("D94 待确认：发给 dm:DongFan：宝", "问课单：WK-20261105-21C8EB"), "WK-20261105-21C8EB");
  assert.equal(draftReference("D181 待确认：回复 Lumist.Grace（私聊）", "好的"), null);
  assert.equal(draftNumber(d190), "D190");
});

test("merges superseded drafts: same recipient and order, or within 10 minutes", () => {
  const grace = [176, 177, 178, 179, 180, 181].map((n, index) => ({
    id: `d${n}`,
    title: index % 2 ? "D" + n + " 待确认：回复 Lumist.Grace（私聊）" : "D" + n + " 待确认：发给 dm:Lumist.Grace：老师好，这单…",
    description: DRAFT_FOOTER,
    created_at: `2026-11-06T08:30:${String(index * 5).padStart(2, "0")}Z`,
  }));
  const gabby = [
    ["d184", "D184 待确认：发给 dm:gabby：REQ-20261105-B37C1422 还缺学校邮箱", "2026-11-05T10:00:00Z"],
    ["d188", "D188 待确认：发给 dm:gabby：REQ-20261105-B37C1422 再催一下学校邮箱", "2026-11-06T02:00:00Z"],
    ["d190", "D190 待确认：发给 dm:gabby：REQ-20261105-B37C1422（诺丁汉宁波 ECONF003）现在只缺一个信息…", "2026-11-06T09:00:00Z"],
  ].map(([id, title, created_at]) => ({ id, title, description: DRAFT_FOOTER, created_at }));
  const others = [
    // 当前会话 without a shared order never merges.
    { id: "d183", title: "D183 待确认：发给 当前会话：宝，BIO120 这单…", created_at: "2026-11-06T08:30:10Z" },
    { id: "d185", title: "D185 待确认：发给 当前会话：宝，另一单", created_at: "2026-11-06T08:31:00Z" },
    // Same recipient, no order, but an hour apart: both stay.
    { id: "d150", title: "D150 待确认：回复 Lumist.Grace（私聊）", created_at: "2026-11-06T07:20:00Z" },
    // Same recipient, one with an order, one without: no merge.
    { id: "d186", title: "D186 待确认：发给 dm:gabby：周末好", created_at: "2026-11-06T09:01:00Z" },
  ];
  const { current, superseded } = findSupersededDrafts([...grace, ...gabby, ...others]);
  assert.equal(current.size, 2);
  assert.deepEqual(current.get("d181").map((item) => item.id), ["d180", "d179", "d178", "d177", "d176"]);
  assert.deepEqual(current.get("d190").map((item) => item.id), ["d188", "d184"]);
  assert.equal(superseded.length, 7);
  assert.ok(superseded.every(({ item, kept }) => item.id !== kept.id));
  assert.equal(supersededReason(gabby[2]), "已被新草稿 D190 替代");
  // The bulk comment is the draft's own reject verb.
  assert.deepEqual(planBatch(superseded.filter(({ kept }) => kept.id === "d190").map(({ item }) => item), "reject", supersededReason(gabby[2])).calls, [
    { content: "不要 已被新草稿 D190 替代", issue_ids: ["d188", "d184"] },
  ]);
  // 当前会话 merges once both drafts name the same order.
  const sameOrder = findSupersededDrafts([
    { id: "a", title: "D200 待确认：发给 当前会话：REQ-20261105-B37C1422 一", created_at: "2026-11-06T01:00:00Z" },
    { id: "b", title: "D201 待确认：发给 当前会话：REQ-20261105-B37C1422 二", created_at: "2026-11-06T05:00:00Z" },
  ]);
  assert.deepEqual([...sameOrder.current.keys()], ["b"]);
});

test("links asks to the drafts they name", () => {
  assert.deepEqual(referencedDrafts("Q35 分身请教：25ABFF98 缺信息 32 小时 + 已提换导师，这单怎么走？", ASK_BODY), ["D187"]);
  assert.deepEqual(
    referencedDrafts("Q30 分身请教：D165 待确认：给销售 … 的三单缺信息催补（已等 24 小时），请选", "A. A 同意发出 D165（三单合并催补销售） B. B 先不发"),
    ["D165"],
  );
  // Option letter "D." and hex inside an id are not draft numbers.
  assert.deepEqual(referencedDrafts("Q1 分身请教：x", "A. A 一 D. D 四 REQ-20261105-D1234567 BD12"), []);
});

test("reads the decision comment of a referenced draft", () => {
  const comments = [
    { content: "// 备注 先等等", created_at: "2026-11-06T01:00:00Z" },
    { content: "不要 已被新草稿 D190 替代\n补充说明", created_at: "2026-11-06T02:00:00Z" },
    { content: "已执行", created_at: "2026-11-06T03:00:00Z" },
  ];
  assert.equal(draftDecisionLine(comments, DRAFT_FOOTER), "不要 已被新草稿 D190 替代");
  assert.equal(draftDecisionLine([{ content: "同意", created_at: "2026-11-06T01:00:00Z" }], ""), "同意");
  assert.equal(draftDecisionLine([{ content: "同意一下再说", created_at: "2026-11-06T01:00:00Z" }], ""), null);
  assert.equal(draftDecisionLine([], ""), null);
  assert.equal(truncateText("一二三四五", 3), "一二三…");
  assert.equal(truncateText("一二", 3), "一二");
});
