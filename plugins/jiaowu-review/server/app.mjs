// Request handling for the three hooks, without the HTTP server, so tests can
// drive it with a fake Multica.

import { createHmac, timingSafeEqual } from "node:crypto";
import { cardDecision } from "../lib/card.mjs";
import { recordEvent, sweep } from "../lib/closeout.mjs";

export const TOLERANCE_SECONDS = 300;

export function createVerifier(signingSecret, now = () => Date.now()) {
  const secret = Buffer.from(String(signingSecret ?? "").replace(/^whsec_/, ""), "hex");
  const seen = new Map();
  return function verify(rawBody, headers) {
    const timestamp = headers["x-multica-timestamp"];
    const presented = String(headers["x-multica-signature"] ?? "").replace(/^v1=/, "");
    if (!timestamp || !presented || secret.length === 0) return "missing signature";
    const drift = Math.abs(Math.floor(now() / 1000) - Number(timestamp));
    if (!Number.isFinite(drift) || drift > TOLERANCE_SECONDS) return "timestamp outside the accepted window";
    const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
    if (presented.length !== expected.length) return "signature does not match";
    if (!timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) return "signature does not match";
    for (const [signature, at] of seen) {
      if (now() - at > TOLERANCE_SECONDS * 1000) seen.delete(signature);
    }
    if (seen.has(presented)) return "replayed request";
    seen.set(presented, now());
    return null;
  };
}

// The Action API as the hook's callback token sees it.
export function callbackClient(body, fetchImpl = fetch) {
  if (!body.callback_url || !body.callback_token) throw new Error("hook request carries no callback");
  async function call(method, path, payload) {
    const response = await fetchImpl(`${body.callback_url}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.callback_token}` },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) throw new Error(`Multica ${method} ${path} answered ${response.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  const storagePath = (key) => `/storage/workspace/${encodeURIComponent(key)}`;
  return {
    getIssue: (id) => call("GET", `/issues/${encodeURIComponent(id)}`),
    listComments: async (id) => (await call("GET", `/issues/${encodeURIComponent(id)}/comments`))?.comments ?? [],
    comment: (id, content) => call("POST", `/issues/${encodeURIComponent(id)}/comments`, { content }),
    store: {
      keys: async () => ((await call("GET", "/storage/workspace"))?.keys ?? []).map((entry) => entry.key),
      get: async (key) => (await call("GET", storagePath(key)))?.value ?? null,
      put: (key, value) => call("PUT", storagePath(key), { value: String(value) }),
      delete: (key) => call("DELETE", storagePath(key)),
    },
  };
}

// Returns [httpStatus, responseBody].
export async function handleHook(path, body, makeClient = callbackClient) {
  if (path === "/hooks/card" && body.trigger === "card_action") {
    const api = makeClient(body);
    const issue = await api.getIssue(body.issue_id);
    const decision = cardDecision(body.input ?? {}, issue);
    // Non-2xx: Multica keeps the card open and lets the person click again.
    if (decision.error) return [422, { error: decision.error }];
    return [200, decision];
  }
  if (path === "/hooks/track" && body.trigger === "event") {
    const api = makeClient(body);
    let issue = body.input?.issue ?? null;
    if (!issue?.title && body.issue_id) issue = await api.getIssue(body.issue_id);
    return [200, await recordEvent(body.event_type, issue, api.store)];
  }
  if (path === "/hooks/sweep" && body.trigger === "schedule") {
    const api = makeClient(body);
    return [200, await sweep(api.store, api)];
  }
  return [404, { error: "unknown hook" }];
}
