import { test } from "node:test";
import { ok, match, deepStrictEqual } from "node:assert";
import { renderUnwindScript } from "../lib/render-unwind.js";
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
    {
      title: "Compres pendents",
      pinned: [],
      unpinned: [{ title: "X", url: "https://x" }],
    },
  ],
};

test("renderUnwindScript: embeds ARC_SPACE_NAMES from payload", () => {
  const src = renderUnwindScript(sample, { dryRun: false });
  const m = src.match(/const ARC_SPACE_NAMES = ([\s\S]+?);\nconst DRY_RUN/);
  ok(m && m[1], "ARC_SPACE_NAMES block not found");
  deepStrictEqual(JSON.parse(m![1]!), ["Personal", "Compres pendents"]);
});

test("renderUnwindScript: dryRun flag is honoured", () => {
  const dry = renderUnwindScript(sample, { dryRun: true });
  match(dry, /const DRY_RUN = true;/);
  ok(dry.includes("DRY: would close tab ids"));
  ok(dry.includes("DRY: nothing was actually removed."));
  const wet = renderUnwindScript(sample, { dryRun: false });
  match(wet, /const DRY_RUN = false;/);
});

test("renderUnwindScript: references the expected API surface", () => {
  const src = renderUnwindScript(sample, { dryRun: false });
  for (const name of [
    "vivaldi.prefs.get",
    "vivaldi.prefs.set",
    "vivaldi.workspaces.list",
    "chrome.tabs.query",
    "chrome.tabs.remove",
    "vivExtData",
    "workspaceId",
  ]) {
    ok(src.includes(name), "expected output to mention " + name);
  }
});

test("renderUnwindScript: is a self-invoking async IIFE", () => {
  const src = renderUnwindScript(sample, { dryRun: false });
  match(src, /\(async \(\) => \{/);
  match(src, /\}\)\(\);\s*$/);
});
