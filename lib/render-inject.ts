import type { InjectablePayload } from "./types.js";

export interface RenderInjectOptions {
  readonly dryRun: boolean;
}

export function renderInjectScript(
  payload: InjectablePayload,
  opts: RenderInjectOptions,
): string {
  const dataLiteral = JSON.stringify(payload, null, 2);
  const dryRunLiteral = opts.dryRun ? "true" : "false";

  return `// Vivaldi Workspaces importer for arc-to-vivaldi-migration.
// Paste into Vivaldi's internal DevTools console
// (chrome://inspect/#apps -> click 'inspect' next to window.html).
//
// Generated: ${payload.generatedAt}
// Source:    ${payload.sourcePath}
// Dry run:   ${dryRunLiteral}
//
// PREREQUISITE: Before running this script, you must manually create one
// empty Vivaldi Workspace per Arc Space, with EXACTLY matching names.
// In Vivaldi's tab bar: click the workspace switcher -> "New Workspace"
// -> type the Arc Space name -> repeat for each Space.
//
// Why manually? Vivaldi exposes no public or private API for workspace
// creation. Direct mutation of the workspaces.list pref makes the
// workspace appear in the pref but unregistered with Vivaldi's internal
// sync layer, so it renders as "Restored Workspace" instead of the
// intended name. Workspaces created via Vivaldi's UI, however, are
// fully registered, and tabs created against them via chrome.tabs.create
// land in the right place with the right name.
//
// If your machine struggles with the volume of new tabs, increase
// THROTTLE_MS below.

const ARC_DATA = ${dataLiteral};
const DRY_RUN = ${dryRunLiteral};
const THROTTLE_MS = 50;

(async () => {
  const log = (...args) => console.log("[arc->vivaldi]", ...args);
  const fail = (msg) => { console.error("[arc->vivaldi] ABORT:", msg); throw new Error(msg); };

  if (typeof vivaldi === "undefined" || !vivaldi || !vivaldi.prefs) {
    fail("vivaldi.prefs not in scope — are you in the internal DevTools console for window.html?");
  }
  if (typeof vivaldi.prefs.get !== "function") {
    fail("vivaldi.prefs.get not callable — Vivaldi may have changed the API. Re-run --probe.");
  }
  if (typeof chrome === "undefined" || !chrome.tabs || typeof chrome.tabs.create !== "function") {
    fail("chrome.tabs.create not available in this context.");
  }

  const getPref = (path) => new Promise((res) => vivaldi.prefs.get(path, res));
  const createTab = (tabOpts) => new Promise((res, rej) =>
    chrome.tabs.create(tabOpts, (t) =>
      chrome.runtime.lastError ? rej(chrome.runtime.lastError.message) : res(t),
    ),
  );
  const sleep = (ms) => ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

  // 1. Read existing workspace list. We only USE these — never mutate.
  const workspaces = await getPref("vivaldi.workspaces.list");
  if (!Array.isArray(workspaces)) {
    fail("vivaldi.workspaces.list returned non-array: " + JSON.stringify(workspaces));
  }
  log("existing workspaces:", workspaces.map((w) => w.id + ":" + w.name).join(", ") || "(none)");

  // 2. Match Arc Space titles to existing Vivaldi workspaces by name.
  const nameToId = new Map();
  for (const w of workspaces) {
    if (typeof w.name === "string") nameToId.set(w.name, w.id);
  }
  const missing = ARC_DATA.spaces.filter((s) => !nameToId.has(s.title)).map((s) => s.title);
  if (missing.length > 0) {
    fail(
      "Missing Vivaldi Workspaces: " + missing.map((n) => '"' + n + '"').join(", ") + ". " +
      "Create them in Vivaldi (workspace switcher -> New Workspace -> type the EXACT name above), " +
      "then re-run this script.",
    );
  }
  log("all", ARC_DATA.spaces.length, "Arc Space names matched to existing workspaces.");

  const summary = { spaces: 0, pinned: 0, unpinned: 0, failures: [] };

  for (const space of ARC_DATA.spaces) {
    const workspaceId = nameToId.get(space.title);
    log("space:", space.title, "id=" + workspaceId,
        "(pinned=" + space.pinned.length + ", unpinned=" + space.unpinned.length + ")");
    summary.spaces++;

    const pinnedBefore = summary.pinned;
    for (const tab of space.pinned) {
      const tabOpts = {
        url: tab.url,
        active: false,
        pinned: true,
        vivExtData: JSON.stringify({ workspaceId }),
      };
      if (DRY_RUN) { log("DRY: createTab", tabOpts); summary.pinned++; continue; }
      try {
        await createTab(tabOpts);
        summary.pinned++;
        await sleep(THROTTLE_MS);
      } catch (err) {
        summary.failures.push({ space: space.title, kind: "pinned", url: tab.url, error: String(err) });
        log("  pinned tab failed:", tab.url, err);
      }
    }
    log("  pinned " + (summary.pinned - pinnedBefore) + "/" + space.pinned.length);

    const unpinnedBefore = summary.unpinned;
    for (const tab of space.unpinned) {
      const tabOpts = {
        url: tab.url,
        active: false,
        pinned: false,
        vivExtData: JSON.stringify({ workspaceId }),
      };
      if (DRY_RUN) { log("DRY: createTab", tabOpts); summary.unpinned++; continue; }
      try {
        await createTab(tabOpts);
        summary.unpinned++;
        await sleep(THROTTLE_MS);
      } catch (err) {
        summary.failures.push({ space: space.title, kind: "unpinned", url: tab.url, error: String(err) });
        log("  unpinned tab failed:", tab.url, err);
      }
    }
    log("  unpinned " + (summary.unpinned - unpinnedBefore) + "/" + space.unpinned.length);
  }

  log("DONE", summary);
  if (summary.failures.length > 0) {
    console.warn("[arc->vivaldi] " + summary.failures.length + " failures — see summary.");
  }
})();
`;
}
