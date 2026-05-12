import { test } from "node:test";
import { ok, match } from "node:assert";
import { renderProbeScript } from "../lib/render-probe.js";

test("renderProbeScript: returns an IIFE", () => {
  const src = renderProbeScript();
  match(src, /^\(\(\) => \{/m);
  match(src, /\}\)\(\);\s*$/);
});

test("renderProbeScript: includes the key probe targets", () => {
  const src = renderProbeScript();
  for (const target of [
    "vivaldi",
    "prefs",
    "tabsPrivate",
    "bookmarksPrivate",
    "sessionsPrivate",
    "windowPrivate",
    "vivaldi.workspaces.list",
    "JSON.stringify",
  ]) {
    ok(src.includes(target), `expected probe to mention ${target}`);
  }
});

test("renderProbeScript: contains no top-level await", () => {
  const src = renderProbeScript();
  ok(!/^\s*await /m.test(src), "probe must not use top-level await");
});
