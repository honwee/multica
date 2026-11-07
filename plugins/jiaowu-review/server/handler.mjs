#!/usr/bin/env node
// Hook server for the 教务审批 plugin.
//
//   MULTICA_SIGNING_SECRET=whsec_… PORT=8787 node server/handler.mjs
//
// The signing secret is shown once, next to the install token, when an admin
// rotates the plugin's token in Settings → Plugins. Multica must reach this
// process over HTTPS at the host the manifest's hooks name; terminate TLS in a
// reverse proxy or set MULTICA_HOOK_TLS_CERT / MULTICA_HOOK_TLS_KEY.
//
// The card hook must answer within 1.5 seconds: Feishu waits about three
// seconds for the whole click.

import { readFileSync } from "node:fs";
import { createServer as createHTTPServer } from "node:http";
import { createServer as createHTTPSServer } from "node:https";
import { createVerifier, handleHook } from "./app.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const SIGNING_SECRET = process.env.MULTICA_SIGNING_SECRET ?? "";
const MAX_BODY_BYTES = 1024 * 1024;

if (!SIGNING_SECRET) {
  console.error("MULTICA_SIGNING_SECRET is required. Rotate the plugin token in Multica to obtain it.");
  process.exit(1);
}

const verify = createVerifier(SIGNING_SECRET);
const tlsCert = process.env.MULTICA_HOOK_TLS_CERT;
const tlsKey = process.env.MULTICA_HOOK_TLS_KEY;
const createServer = tlsCert && tlsKey
  ? (handler) => createHTTPSServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }, handler)
  : createHTTPServer;

function reply(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    reply(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST") {
    reply(response, 405, { error: "method not allowed" });
    return;
  }
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", async () => {
    const raw = Buffer.concat(chunks);
    const failure = verify(raw, request.headers);
    if (failure) {
      console.warn(`rejected ${request.url}: ${failure}`);
      reply(response, 401, { error: failure });
      return;
    }
    try {
      const body = JSON.parse(raw.toString("utf8"));
      const [status, result] = await handleHook(request.url, body);
      console.log(JSON.stringify({ path: request.url, trigger: body.trigger, event: body.event_type, status, result }));
      reply(response, status, result);
    } catch (error) {
      console.error(`${request.url}:`, error);
      reply(response, 502, { error: "hook failed" });
    }
  });
}).listen(PORT, () => console.log(`jiaowu-review hooks listening on ${tlsCert ? "https" : "http"}://0.0.0.0:${PORT}`));
