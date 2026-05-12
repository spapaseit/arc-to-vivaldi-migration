export function renderProbeScript(): string {
  return `(() => {
  const result = {
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    vivaldi: { available: false },
  };

  try {
    if (typeof vivaldi !== "undefined" && vivaldi) {
      result.vivaldi.available = true;
      result.vivaldi.keys = Object.keys(vivaldi).sort();
      result.vivaldi.namespaces = {};

      // Namespaces of interest for the importer. There is no public
      // "workspaces" namespace — Workspaces live in vivaldi.prefs under
      // path "vivaldi.workspaces.list".
      const candidates = [
        "prefs",
        "tabsPrivate",
        "bookmarksPrivate",
        "sessionsPrivate",
        "windowPrivate",
      ];

      for (const ns of candidates) {
        const obj = vivaldi[ns];
        if (!obj) {
          result.vivaldi.namespaces[ns] = { present: false };
          continue;
        }
        const members = {};
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (typeof v === "function") {
            try {
              members[k] = v.toString().slice(0, 200);
            } catch (e) {
              members[k] = "<function (toString failed)>";
            }
          } else {
            members[k] = typeof v;
          }
        }
        result.vivaldi.namespaces[ns] = { present: true, members };
      }

      // Read the actual workspaces list — that is the source of truth.
      result.workspacesProbe = {};
      const pending = [];

      if (vivaldi.prefs && typeof vivaldi.prefs.get === "function") {
        pending.push(
          new Promise((res) => {
            try {
              vivaldi.prefs.get("vivaldi.workspaces.list", (value) => {
                if (chrome.runtime && chrome.runtime.lastError) {
                  result.workspacesProbe["vivaldi.workspaces.list"] = {
                    ok: false,
                    error: chrome.runtime.lastError.message,
                  };
                } else {
                  result.workspacesProbe["vivaldi.workspaces.list"] = {
                    ok: true,
                    count: Array.isArray(value) ? value.length : null,
                    sample: Array.isArray(value) ? value.slice(0, 3) : value,
                  };
                }
                res();
              });
            } catch (e) {
              result.workspacesProbe["vivaldi.workspaces.list"] = { ok: false, error: String(e) };
              res();
            }
          }),
        );
      } else {
        result.workspacesProbe["vivaldi.workspaces.list"] = {
          ok: false,
          error: "vivaldi.prefs.get not available",
        };
      }

      Promise.allSettled(pending).then(() => {
        console.log(JSON.stringify(result, null, 2));
      });
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e) {
    result.error = String(e);
    console.log(JSON.stringify(result, null, 2));
  }

  return result;
})();
`;
}
