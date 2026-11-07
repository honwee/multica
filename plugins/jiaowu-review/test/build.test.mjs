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

test("the page styles give every token newer than desktop 0.8.8 a fallback", () => {
  const page = readFileSync(new URL("../ui/page.mjs", import.meta.url), "utf8");
  const legacy = new Set([
    "--background", "--foreground", "--muted", "--muted-foreground", "--border", "--primary",
    "--primary-foreground", "--destructive", "--radius", "--text-caption", "--text-body",
  ]);
  const bare = [...page.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)].map((match) => match[1]).filter((name) => !name.startsWith("--jr-") && !legacy.has(name));
  assert.deepEqual(bare, []);
});
