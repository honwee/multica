// Card action handler for Workspace Review.
//
// Multica calls this when someone clicks 同意 / 修改 / 不要 on a Feishu
// notification card whose issue title starts with "[审批]". It answers what
// Multica should do as the person who clicked; Multica performs it, marks it
// as made through this plugin, and replaces the card with the decision.
//
// The answer must arrive within 1.5 seconds — Feishu waits about three
// seconds for the whole callback. Do slow work after answering.
//
//   MULTICA_SIGNING_SECRET=whsec_… node server/handler.mjs

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const SECRET = Buffer.from((process.env.MULTICA_SIGNING_SECRET ?? "").replace(/^whsec_/, ""), "hex");
const TOLERANCE_SECONDS = 300;
const seen = new Map();

function verify(raw, timestamp, presented) {
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", SECRET).update(`${timestamp}.`).update(raw).digest("hex");
  const given = String(presented ?? "").replace(/^v1=/, "");
  if (given.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return false;
  // The host also runs each card decision once; remembering signatures closes
  // the replay window on this side too.
  if (seen.has(given)) return false;
  seen.set(given, Date.now());
  return true;
}

function decide({ button, input }) {
  switch (button) {
    case "approve":
      return { effects: [{ type: "comment", content: "同意。" }, { type: "set_status", status: "done" }], status_text: "已同意" };
    case "revise":
      return { effects: [{ type: "comment", content: `需要修改：${input}` }, { type: "set_status", status: "in_progress" }], status_text: "已要求修改" };
    case "reject":
      return { effects: [{ type: "comment", content: "不同意。" }, { type: "set_status", status: "cancelled" }], status_text: "已拒绝" };
    default:
      return { status_text: "未知操作" };
  }
}

createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const raw = Buffer.concat(chunks);
    if (!verify(raw, request.headers["x-multica-timestamp"], request.headers["x-multica-signature"])) {
      response.writeHead(401).end();
      return;
    }
    const body = JSON.parse(raw.toString("utf8"));
    if (body.trigger !== "card_action") {
      response.writeHead(400).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(decide(body.input ?? {})));
  });
}).listen(8787);
