import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildPage } from "../build.mjs";

test("ui/main.js is the current build of ui/page.mjs", () => {
  const committed = readFileSync(new URL("../ui/main.js", import.meta.url), "utf8");
  assert.equal(committed, buildPage(), "run `node plugins/jiaowu-review/build.mjs`");
});

test("the page bundle has no module syntax", () => {
  const bundle = buildPage();
  assert.doesNotMatch(bundle, /^\s*(import|export)\s/m);
});
