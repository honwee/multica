import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWebDevArgs } from "./dev-web.mjs";

test("normalizes preview host arguments without changing other options", () => {
  assert.deepEqual(normalizeWebDevArgs(["--host", "127.0.0.1", "--port", "7100"]), ["--hostname", "127.0.0.1", "--port", "7100"]);
  assert.deepEqual(normalizeWebDevArgs(["--host=0.0.0.0", "--port=7200"]), ["--hostname=0.0.0.0", "--port=7200"]);
  assert.deepEqual(normalizeWebDevArgs(["--hostname", "::1", "-p", "7300"]), ["--hostname", "::1", "-p", "7300"]);
  assert.deepEqual(normalizeWebDevArgs([]), []);
});
