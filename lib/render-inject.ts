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
// HOW IT WORKS (empirically confirmed against Vivaldi UA Chrome/146):
//   - chrome.tabs.create silently ignores vivExtData.workspaceId under
//     load and stamps new tabs with the currently-active workspace's id.
//   - chrome.tabs.update WITH vivExtData DOES correctly reassign the
//     tab to a different workspace, both in metadata and in the UI.
//   - So: we create each tab (it briefly lands in the active workspace),
//     then immediately update vivExtData.workspaceId to migrate it to
//     the right workspace. Net effect: tabs flicker through whatever
//     workspace is active, then settle in their target. Don't switch
//     workspaces during the import or the visual flicker gets ugly
//     (the assignment is still correct via metadata).
//
// After each create+update we also call chrome.tabs.discard to release
// the tab's renderer immediately. Without this, Vivaldi tries to fully
// load every newly created tab, and 300+ concurrent loads will eat all
// your memory and freeze the system. With discard, the tab stays in the
// workspace with its URL intact but is unloaded — same as Arc's
// always-pinned tabs behave by default.
//
// If your machine still struggles, increase THROTTLE_MS below.

const ARC_DATA = ${dataLiteral};
const DRY_RUN = ${dryRunLiteral};
const THROTTLE_MS = 100;

(async () => {
  const log = (...args) => console.log("[arc->vivaldi]", ...args);
  const fail = (msg) => { console.error("[arc->vivaldi] ABORT:", msg); throw new Error(msg); };

  if (typeof vivaldi === "undefined" || !vivaldi || !vivaldi.prefs) {
    fail("vivaldi.prefs not in scope — are you in the internal DevTools console for window.html?");
  }
  if (typeof vivaldi.prefs.get !== "function") {
    fail("vivaldi.prefs.get not callable — Vivaldi may have changed the API. Re-run --probe.");
  }
  if (typeof chrome === "undefined" || !chrome.tabs || typeof chrome.tabs.create !== "function" || typeof chrome.tabs.update !== "function") {
    fail("chrome.tabs.create / chrome.tabs.update not available in this context.");
  }

  const getPref = (path) => new Promise((res) => vivaldi.prefs.get(path, res));
  const createTab = (tabOpts) => new Promise((res, rej) =>
    chrome.tabs.create(tabOpts, (t) =>
      chrome.runtime.lastError ? rej(chrome.runtime.lastError.message) : res(t),
    ),
  );
  const updateTab = (tabId, updateInfo) => new Promise((res, rej) =>
    chrome.tabs.update(tabId, updateInfo, (t) =>
      chrome.runtime.lastError ? rej(chrome.runtime.lastError.message) : res(t),
    ),
  );
  // Discard is best-effort. Some tabs (active, pinned, or still in initial
  // load) refuse discard; that's fine — Vivaldi will lazy-discard on its own
  // schedule. We swallow any lastError.
  const discardTab = (tabId) => new Promise((res) => {
    if (typeof chrome.tabs.discard !== "function") { res(); return; }
    try {
      chrome.tabs.discard(tabId, () => {
        void chrome.runtime.lastError;
        res();
      });
    } catch (e) { res(); }
  });
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
  log("NOTE: do not switch workspaces during the import. Tabs will briefly appear");
  log("      in whatever workspace is active, then migrate to their target.");

  const summary = { spaces: 0, pinned: 0, unpinned: 0, failures: [] };

  // Each tab: create (lands in active workspace, possibly with the wrong
  // pinned state since Vivaldi drops create-time options under load), then
  // chrome.tabs.update to overwrite BOTH vivExtData.workspaceId and the
  // pinned flag. Update is the call Vivaldi reliably honours. Finally,
  // discard the tab to release its renderer — without this, 300+ tabs
  // loading concurrently will freeze the system.
  const createAndAssign = async (url, pinned, workspaceId) => {
    const created = await createTab({ url, active: false, pinned });
    await updateTab(created.id, {
      vivExtData: JSON.stringify({ workspaceId }),
      pinned,
    });
    await discardTab(created.id);
    return created;
  };

  for (const space of ARC_DATA.spaces) {
    const workspaceId = nameToId.get(space.title);
    log("space:", space.title, "id=" + workspaceId,
        "(pinned=" + space.pinned.length + ", unpinned=" + space.unpinned.length + ")");
    summary.spaces++;

    const pinnedBefore = summary.pinned;
    for (const tab of space.pinned) {
      if (DRY_RUN) {
        log("DRY: createAndAssign", { url: tab.url, pinned: true, workspaceId });
        summary.pinned++;
        continue;
      }
      try {
        await createAndAssign(tab.url, true, workspaceId);
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
      if (DRY_RUN) {
        log("DRY: createAndAssign", { url: tab.url, pinned: false, workspaceId });
        summary.unpinned++;
        continue;
      }
      try {
        await createAndAssign(tab.url, false, workspaceId);
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
