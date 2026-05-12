import type { InjectablePayload } from "./types.js";

export interface RenderUnwindOptions {
  readonly dryRun: boolean;
}

/**
 * Emits a JS payload that, when pasted into Vivaldi's internal DevTools console,
 * closes all tabs whose `vivExtData.workspaceId` references a Vivaldi Workspace
 * whose `name` matches one of the Arc Space titles in `payload`.
 *
 * It does NOT remove the workspace entries themselves — those are created by
 * the user via Vivaldi's UI as a prerequisite of the import flow, so removing
 * them on unwind would destroy user-managed state.
 *
 * Match is by NAME because the workspace ids are owned by Vivaldi and we can't
 * embed them at generation time.
 */
export function renderUnwindScript(
  payload: InjectablePayload,
  opts: RenderUnwindOptions,
): string {
  const namesLiteral = JSON.stringify(
    payload.spaces.map((s) => s.title),
    null,
    2,
  );
  const dryRunLiteral = opts.dryRun ? "true" : "false";

  return `// Vivaldi Workspaces unwinder for arc-to-vivaldi-migration.
// Paste into Vivaldi's internal DevTools console
// (chrome://inspect/#apps -> click 'inspect' next to window.html).
//
// Closes any tab whose vivExtData.workspaceId points at a workspace whose
// name matches one of ARC_SPACE_NAMES below. Leaves the workspace entries
// themselves intact — you created them in Vivaldi's UI, so they're yours
// to manage.
//
// Generated: ${payload.generatedAt}
// Source:    ${payload.sourcePath}
// Dry run:   ${dryRunLiteral}

const ARC_SPACE_NAMES = ${namesLiteral};
const DRY_RUN = ${dryRunLiteral};

(async () => {
  const log = (...args) => console.log("[arc-unwind]", ...args);
  const fail = (msg) => { console.error("[arc-unwind] ABORT:", msg); throw new Error(msg); };

  if (typeof vivaldi === "undefined" || !vivaldi || !vivaldi.prefs) {
    fail("vivaldi.prefs not in scope — are you in the internal DevTools console for window.html?");
  }
  if (typeof chrome === "undefined" || !chrome.tabs || typeof chrome.tabs.query !== "function") {
    fail("chrome.tabs not available in this context.");
  }

  const getPref = (path) => new Promise((res) => vivaldi.prefs.get(path, res));
  const queryTabs = () => new Promise((res) => chrome.tabs.query({}, res));
  const removeTabs = (ids) => new Promise((res, rej) =>
    chrome.tabs.remove(ids, () =>
      chrome.runtime.lastError ? rej(chrome.runtime.lastError.message) : res(),
    ),
  );

  const list = await getPref("vivaldi.workspaces.list");
  if (!Array.isArray(list)) fail("workspaces.list is not an array: " + JSON.stringify(list));

  const nameSet = new Set(ARC_SPACE_NAMES);
  const targets = list.filter((w) => nameSet.has(w.name));
  const targetIds = new Set(targets.map((w) => w.id));

  log("workspaces matching Arc Space names:", targets.map((w) => w.id + ":" + w.name));

  if (targets.length === 0) {
    log("nothing to unwind. Done.");
    return;
  }

  const allTabs = await queryTabs();
  const tabsToClose = allTabs.filter((t) => {
    if (!t.vivExtData) return false;
    try {
      const parsed = typeof t.vivExtData === "string" ? JSON.parse(t.vivExtData) : t.vivExtData;
      return parsed && targetIds.has(parsed.workspaceId);
    } catch (e) {
      return false;
    }
  });
  const tabIds = tabsToClose.map((t) => t.id).filter((id) => typeof id === "number" && id >= 0);

  log("tabs to close:", tabIds.length, "(across", targets.length, "workspace(s))");

  if (DRY_RUN) {
    log("DRY: would close tab ids", tabIds);
    log("DRY: workspaces.list would be left untouched.");
    log("DRY: nothing was actually removed.");
    return;
  }

  if (tabIds.length > 0) {
    try {
      await removeTabs(tabIds);
      log("closed", tabIds.length, "tab(s).");
    } catch (e) {
      log("tab removal failed:", e);
    }
  }

  log("workspaces.list left intact — manage the workspace entries via Vivaldi's UI.");
  log("DONE");
})();
`;
}
