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

test("card buttons match by title prefix only, never by project", () => {
  const manifest = JSON.parse(readFileSync(new URL("../multica.plugin.json", import.meta.url), "utf8"));
  const rules = Object.fromEntries(manifest.contributes.card_buttons.map((rule) => [rule.key, rule.match]));
  assert.deepEqual(rules, {
    draft: { title_prefixes: ["D"] },
    proposal: { title_prefixes: ["#"] },
    ask: { title_prefixes: ["Q"] },
  });
});
