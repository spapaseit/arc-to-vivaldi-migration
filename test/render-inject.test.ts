import { test } from "node:test";
import { ok, match, deepStrictEqual } from "node:assert";
import { renderInjectScript } from "../lib/render-inject.js";
import type { InjectablePayload } from "../lib/types.js";

const sample: InjectablePayload = {
  generatedAt: "2026-05-12T10:00:00.000Z",
  sourcePath: "/tmp/x.json",
  spaces: [
    {
      title: "Personal",
      pinned: [{ title: "P", url: "https://p" }],
      unpinned: [{ title: "U", url: "https://u" }],
    },
  ],
};

test("renderInjectScript: embeds ARC_DATA literal", () => {
  const src = renderInjectScript(sample, { dryRun: false });
  ok(src.includes("const ARC_DATA"));
  ok(src.includes("https://p"));
  ok(src.includes("Personal"));
});

test("renderInjectScript: dryRun flag is honoured", () => {
  const dry = renderInjectScript(sample, { dryRun: true });
  match(dry, /const DRY_RUN = true;/);
  ok(dry.includes("DRY: createAndAssign"));
  const wet = renderInjectScript(sample, { dryRun: false });
  match(wet, /const DRY_RUN = false;/);
});

test("renderInjectScript: references the expected private API surface", () => {
  const src = renderInjectScript(sample, { dryRun: false });
  for (const name of [
    "vivaldi.prefs.get",
    "vivaldi.workspaces.list",
    "chrome.tabs.create",
    "chrome.tabs.update",
    "vivExtData",
    "THROTTLE_MS",
  ]) {
    ok(src.includes(name), "expected output to mention " + name);
  }
});

test("renderInjectScript: uses create-then-update to assign workspace", () => {
  const src = renderInjectScript(sample, { dryRun: false });
  ok(src.includes("createAndAssign"), "expected create+update helper named createAndAssign");
  // The create call must NOT include vivExtData (Vivaldi ignores it under load),
  // and assignment must happen via a subsequent chrome.tabs.update.
  const createMatch = src.match(/createTab\(\{[^}]+\}\)/);
  ok(createMatch, "expected a createTab call");
  ok(!createMatch![0].includes("vivExtData"), "create call must NOT include vivExtData — it is ignored at create time");
});

test("renderInjectScript: discards each tab after assignment to spare resources", () => {
  const src = renderInjectScript(sample, { dryRun: false });
  ok(src.includes("chrome.tabs.discard"), "expected chrome.tabs.discard call to release renderers");
  ok(src.includes("discardTab"), "expected a discardTab helper");
});

test("renderInjectScript: unwraps the {defaultValue, value} pref descriptor", () => {
  const src = renderInjectScript(sample, { dryRun: false });
  // Some Vivaldi builds return the bare value from prefs.get, others wrap it
  // in a { defaultValue, value } descriptor. The reader must handle both or
  // it aborts with "returned non-array" on the wrapping builds.
  ok(src.includes("unwrapPref"), "expected an unwrapPref helper");
  ok(src.includes('"value" in result'), "expected unwrap to detect the descriptor's value key");
});

test("renderInjectScript: logs the Chromium version for diagnostics without gating on it", () => {
  const src = renderInjectScript(sample, { dryRun: false });
  ok(src.includes("navigator.userAgent"), "expected the version to be read from the UA");
  ok(src.includes("Chromium version"), "expected a version log line");
});

test("renderInjectScript: parses the UA via split, not a regex (template literals eat backslashes)", () => {
  const src = renderInjectScript(sample, { dryRun: false });
  // A regex literal here would lose its \d / \. / \/ escapes when emitted
  // through the template literal, producing a valid-but-wrong matcher that
  // includes()-checks and parse-checks both miss. So we read the version with
  // string ops and assert that, not a regex.
  ok(src.includes('split("Chrome/")'), "expected UA version parsed via split");
  ok(!/navigator\.userAgent\.match\(/.test(src), "must not parse the UA with a regex literal");
});

test("renderInjectScript: does NOT mutate the workspaces.list pref", () => {
  const src = renderInjectScript(sample, { dryRun: false });
  ok(!src.includes("vivaldi.prefs.set"), "inject must not write the workspaces pref — user owns it now");
});

test("renderInjectScript: instructs the user to pre-create workspaces in Vivaldi", () => {
  const src = renderInjectScript(sample, { dryRun: false });
  ok(src.includes("PREREQUISITE"), "expected prereq comment");
  ok(src.includes("Missing Vivaldi Workspaces"), "expected runtime error referencing missing workspace names");
});

test("renderInjectScript: is a self-invoking async IIFE", () => {
  const src = renderInjectScript(sample, { dryRun: false });
  match(src, /\(async \(\) => \{/);
  match(src, /\}\)\(\);\s*$/);
});

test("renderInjectScript: ARC_DATA parses back to the original payload", () => {
  const src = renderInjectScript(sample, { dryRun: false });
  const m = src.match(/const ARC_DATA = ([\s\S]+?);\nconst DRY_RUN/);
  ok(m && m[1], "ARC_DATA block not found");
  const parsed = JSON.parse(m![1]!);
  deepStrictEqual(parsed, sample);
});
