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
// API notes (confirmed empirically against Vivaldi UA Chrome/146):
//   - Workspaces live in pref "vivaldi.workspaces.list" as an array of
//     { id: number, name: string, emoji?: string, icon?: string }.
//   - vivaldi.prefs.set takes ONE argument ({ path, value }) and returns sync.
//   - chrome.tabs.create's vivExtData is a JSON STRING, not an object.

const ARC_DATA = ${dataLiteral};
const DRY_RUN = ${dryRunLiteral};

(async () => {
  const log = (...args) => console.log("[arc->vivaldi]", ...args);
  const fail = (msg) => { console.error("[arc->vivaldi] ABORT:", msg); throw new Error(msg); };

  if (typeof vivaldi === "undefined" || !vivaldi || !vivaldi.prefs) {
    fail("vivaldi.prefs not in scope — are you in the internal DevTools console for window.html?");
  }
  if (typeof vivaldi.prefs.get !== "function" || typeof vivaldi.prefs.set !== "function") {
    fail("vivaldi.prefs.get/set not callable — Vivaldi may have changed the API. Re-run --probe.");
  }
  if (typeof chrome === "undefined" || !chrome.tabs || typeof chrome.tabs.create !== "function") {
    fail("chrome.tabs.create not available in this context.");
  }

  const getPref = (path) => new Promise((res) => vivaldi.prefs.get(path, res));
  const setPref = (path, value) => vivaldi.prefs.set({ path, value });
  const createTab = (tabOpts) => new Promise((res, rej) =>
    chrome.tabs.create(tabOpts, (t) =>
      chrome.runtime.lastError ? rej(chrome.runtime.lastError.message) : res(t),
    ),
  );

  // 1. Read existing workspace list.
  const existingList = await getPref("vivaldi.workspaces.list");
  if (!Array.isArray(existingList)) {
    fail("vivaldi.workspaces.list returned non-array: " + JSON.stringify(existingList));
  }
  log("existing workspaces:", existingList.length);

  // 2. Build new workspace entries — one per Arc Space.
  // IDs use Date.now() + offset; numeric, unique enough for a one-shot import.
  const baseId = Date.now();
  const newWorkspaces = ARC_DATA.spaces.map((s, i) => ({
    id: baseId + i,
    name: s.title,
  }));

  // 3. Write the updated list (single set, not one per workspace).
  const updatedList = [...existingList, ...newWorkspaces];
  if (DRY_RUN) {
    log("DRY: would set vivaldi.workspaces.list — adding", newWorkspaces.length, "entries:",
        newWorkspaces.map((w) => w.id + ":" + w.name).join(", "));
  } else {
    setPref("vivaldi.workspaces.list", updatedList);
    log("workspaces.list updated; added:",
        newWorkspaces.map((w) => w.id + ":" + w.name).join(", "));
  }

  const summary = { spaces: 0, pinned: 0, unpinned: 0, failures: [] };

  for (let i = 0; i < ARC_DATA.spaces.length; i++) {
    const space = ARC_DATA.spaces[i];
    const workspace = newWorkspaces[i];
    log("space:", space.title, "id=" + workspace.id,
        "(pinned=" + space.pinned.length + ", unpinned=" + space.unpinned.length + ")");
    summary.spaces++;

    const pinnedBefore = summary.pinned;
    for (const tab of space.pinned) {
      const tabOpts = {
        url: tab.url,
        active: false,
        pinned: true,
        vivExtData: JSON.stringify({ workspaceId: workspace.id }),
      };
      if (DRY_RUN) { log("DRY: createTab", tabOpts); summary.pinned++; continue; }
      try {
        await createTab(tabOpts);
        summary.pinned++;
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
        vivExtData: JSON.stringify({ workspaceId: workspace.id }),
      };
      if (DRY_RUN) { log("DRY: createTab", tabOpts); summary.unpinned++; continue; }
      try {
        await createTab(tabOpts);
        summary.unpinned++;
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
