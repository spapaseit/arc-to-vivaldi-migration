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
// After each create+update we schedule a DEFERRED chrome.tabs.discard
// (DISCARD_DELAY_MS later). The discard releases the renderer to free
// memory, but the delay is critical: Chromium only persists discarded
// tabs to the session file if the tab reached a "committed" navigation
// state first. Discarding immediately after create skipped that
// commit, and on Vivaldi restart the tabs vanished. The deferral gives
// Vivaldi time to commit the navigation before we tear down the
// renderer. At peak, roughly DISCARD_DELAY_MS / THROTTLE_MS concurrent
// loads are in flight — bounded and manageable.
//
// If your machine still struggles, increase THROTTLE_MS below.
// If imported tabs disappear after a Vivaldi restart, increase
// DISCARD_DELAY_MS.

const ARC_DATA = ${dataLiteral};
const DRY_RUN = ${dryRunLiteral};
const THROTTLE_MS = 100;
const DISCARD_DELAY_MS = 1000;

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

  // Diagnostics only — NOT used to branch behaviour. The private-API shapes we
  // touch are detected structurally (see unwrapPref below), so this importer
  // is version-agnostic. We log the Chromium version purely so that if a
  // future Vivaldi build does break something, the console output records the
  // version it broke on. Last verified working on Chromium 146 and 148.
  // Parse via split (not regex): this whole script is emitted through a JS
  // template literal, which would eat the backslashes in a regex literal.
  // UA tail looks like "Chrome/148.0.0.0 Safari/537.36" -> take "148.0.0.0".
  const chromiumVersion = ((navigator.userAgent.split("Chrome/")[1] || "").split(" ")[0]) || "unknown";
  log("Chromium version (from UA):", chromiumVersion, "— verified on 146/148; re-run --probe if the API surface shifted.");

  // vivaldi.prefs.get's callback shape varies across Vivaldi versions: some
  // builds hand back the bare value, others wrap it in a pref descriptor
  // { defaultValue, value }. Unwrap .value when we see that shape so the rest
  // of the script always works with the real value. (Confirmed via --probe:
  // newer Chromium-based builds return the descriptor.)
  const unwrapPref = (result) =>
    result && typeof result === "object" && !Array.isArray(result) && "value" in result
      ? result.value
      : result;
  const getPref = (path) => new Promise((res) => vivaldi.prefs.get(path, (result) => res(unwrapPref(result))));
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

  // Each tab: create + immediate update (assigns workspace + pinned
  // state, both of which Vivaldi drops at create time but honours via
  // update). Then SCHEDULE a deferred discard — see the header comment
  // for why the deferral matters for session persistence. The discard
  // promise is collected so the caller can await them all before
  // declaring the import done.
  const pendingDiscards = [];
  const createAndAssign = async (url, pinned, workspaceId) => {
    const created = await createTab({ url, active: false, pinned });
    await updateTab(created.id, {
      vivExtData: JSON.stringify({ workspaceId }),
      pinned,
    });
    pendingDiscards.push(new Promise((res) => {
      setTimeout(async () => { await discardTab(created.id); res(); }, DISCARD_DELAY_MS);
    }));
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

  // Wait for all scheduled discards to fire before declaring done. This
  // matters: if the script returns while discards are still pending,
  // they fire in the background; if the user closes Vivaldi in that
  // window, some tabs may not have been discarded yet (a memory issue,
  // not a correctness issue — but worth waiting the few seconds).
  if (pendingDiscards.length > 0) {
    log("waiting for " + pendingDiscards.length + " pending discards to settle...");
    await Promise.all(pendingDiscards);
  }

  log("DONE", summary);
  if (summary.failures.length > 0) {
    console.warn("[arc->vivaldi] " + summary.failures.length + " failures — see summary.");
  }
})();
`;
}
