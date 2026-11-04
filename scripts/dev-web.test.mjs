import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadWebPreviewEnv, normalizeWebDevArgs } from "./dev-web.mjs";

test("normalizes preview host arguments without changing other options", () => {
  assert.deepEqual(normalizeWebDevArgs(["--host", "127.0.0.1", "--port", "7100"]), ["--hostname", "127.0.0.1", "--port", "7100"]);
  assert.deepEqual(normalizeWebDevArgs(["--host=0.0.0.0", "--port=7200"]), ["--hostname=0.0.0.0", "--port=7200"]);
  assert.deepEqual(normalizeWebDevArgs(["--hostname", "::1", "-p", "7300"]), ["--hostname", "::1", "-p", "7300"]);
  assert.deepEqual(normalizeWebDevArgs([]), []);
});

test("loads an explicit preview backend and keeps browser requests same-origin", () => {
  const directory = mkdtempSync(join(tmpdir(), "multica-preview-"));
  const filePath = join(directory, "preview.json");
  try {
    writeFileSync(filePath, JSON.stringify({ remoteApiUrl: "https://preview.example.com" }));
    assert.deepEqual(loadWebPreviewEnv(filePath), {
      REMOTE_API_URL: "https://preview.example.com",
      NEXT_PUBLIC_API_URL: "",
      NEXT_PUBLIC_WS_URL: "",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.deepEqual(loadWebPreviewEnv(filePath), {});
});
