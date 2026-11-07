// Workspace Review — a minimal workspace_page surface.
//
// Lists the issues waiting for review, lets the reader tick several, and
// comments on or approves them in one go. Every call goes through the host
// bridge and runs as the signed-in user; the host checks each issue on its
// own and answers with one result per issue.
//
// Like hello-panel, this inlines a tiny bridge client so it is a single file
// with nothing to install. A real plugin imports `@multica/plugin-sdk` and
// calls `multica.issues.list / batchComment / batchSetStatus`.

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

const STATUS = "in_review";
const selected = new Set();
const root = document.getElementById("root");

root.innerHTML = `
  <div style="padding:16px; display:grid; gap:12px">
    <div style="display:flex; gap:8px; align-items:center">
      <strong style="flex:1">Waiting for review</strong>
      <button id="comment">Comment “已阅”</button>
      <button id="approve">Mark done</button>
    </div>
    <div id="status" style="color:var(--muted-foreground)"></div>
    <ul id="list" style="list-style:none; margin:0; padding:0; display:grid; gap:4px"></ul>
    <button id="more" hidden>Load more</button>
  </div>`;

const list = document.getElementById("list");
const status = document.getElementById("status");
const more = document.getElementById("more");
let nextOffset = 0;

async function load() {
  status.textContent = "Loading…";
  try {
    const page = await call("GET", `/issues?status=${STATUS}&limit=50&offset=${nextOffset}`);
    for (const issue of page.issues) {
      const item = document.createElement("li");
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.onchange = () => (box.checked ? selected.add(issue.id) : selected.delete(issue.id));
      label.append(box, ` ${issue.identifier} ${issue.title}`);
      item.append(label);
      list.append(item);
    }
    nextOffset = page.next_offset ?? 0;
    more.hidden = page.next_offset == null;
    status.textContent = list.children.length === 0 ? "Nothing is waiting for review." : "";
  } catch (error) {
    // 403 plugin_extension_disabled means an admin has not switched pages on.
    status.textContent = String(error.message ?? error);
  }
}

async function batch(path, body) {
  if (selected.size === 0) return;
  status.textContent = "Working…";
  const result = await call("POST", path, { issue_ids: [...selected], ...body });
  const failed = result.results.filter((item) => item.status !== "ok");
  status.textContent = `${result.succeeded} done` +
    (failed.length ? `, ${failed.length} refused: ${failed.map((item) => `${item.issue_id} (${item.status})`).join(", ")}` : "");
}

document.getElementById("comment").onclick = () => batch("/issue-batches/comments", { content: "已阅" });
document.getElementById("approve").onclick = () => batch("/issue-batches/status", { status: "done" });
more.onclick = load;
load();
