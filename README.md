# arc-to-vivaldi-migration

A single-file TypeScript converter that turns Arc Browser's `StorableSidebar.json`
into a Netscape-format HTML bookmarks file, ready to import into Vivaldi (or
any other browser that accepts the standard bookmark HTML format).

Arc shut down its development; this is the escape hatch for everyone whose
sidebar is full of years of carefully curated tabs.

## What it does

- Reads Arc's sidebar JSON and reconstructs the tree (Spaces → Pinned/Unpinned
  → folders → bookmarks).
- Emits a Netscape-format bookmarks HTML file.
- Optionally splits the output: one file per Space, so you can import each
  Space into a different folder or profile.

## Requirements

- Node.js 18 or newer.
- The path to your `StorableSidebar.json`. On Windows the script will find it
  automatically; on macOS pass `--input` explicitly.

Typical locations:

| OS      | Path                                                                                       |
| ------- | ------------------------------------------------------------------------------------------ |
| Windows | `%LOCALAPPDATA%\Packages\TheBrowserCompany.Arc_<hash>\LocalCache\Local\Arc\StorableSidebar.json` |
| macOS   | `~/Library/Application Support/Arc/StorableSidebar.json`                                   |

## Install

```bash
git clone https://github.com/spapaseit/arc-to-vivaldi-migration.git
cd arc-to-vivaldi-migration
npm install
```

## Usage

```bash
# Auto-discover input on Windows, write ./arc-bookmarks.html
npx tsx arc-to-vivaldi.ts

# Explicit paths
npx tsx arc-to-vivaldi.ts --input ./StorableSidebar.json --output ./bookmarks.html

# One HTML file per Space, written into ./out/
npx tsx arc-to-vivaldi.ts --split --output ./out

# Verbose — per-Space counts
npx tsx arc-to-vivaldi.ts -v
```

Flags:

| Flag              | Description                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| `--input <path>`  | Path to `StorableSidebar.json`. Defaults to Windows auto-discovery.       |
| `--output <path>` | Output file (combined mode) or directory (with `--split`).                |
| `--split`         | One file per Space, named `arc-<slug>.html`.                              |
| `-v`, `--verbose` | Print a per-Space breakdown.                                              |
| `-h`, `--help`    | Print usage.                                                              |
| `--probe`              | Emit `probe-vivaldi.js` for Vivaldi private-API discovery. See "Experimental" section below. |
| `--inject`             | Emit `vivaldi-import.js` — a paste-able importer that creates Vivaldi Workspaces from your Arc Spaces. |
| `--inject-dry-run`     | Same as `--inject` but logs intended API calls instead of making them.                    |

## Importing into Vivaldi

`Vivaldi menu → File → Import Bookmarks and Settings…` → choose **Bookmarks
HTML File** and point it at the generated file. Each Space becomes a top-level
folder containing `Pinned` and `Unpinned` subfolders, mirroring Arc's layout.

## Experimental: recreate Arc Spaces as Vivaldi Workspaces

**Status:** working as of Vivaldi on Chromium 146 (late-2025/early-2026 builds).
Verified end-to-end on a ~315-tab import across five Spaces. Workspace
assignment, pinned state, and tab discarding all behave correctly. Tab Stacks
(folders within a workspace) are still manual — see the bottom of this section.

The HTML import only covers bookmarks. If you also want Arc's Spaces populated
into Vivaldi Workspaces as real open tabs (pinned and regular), there is a
paste-into-DevTools workflow.

> **Caveat 1:** Vivaldi exposes no public or private API for *creating*
> Workspaces — direct mutation of the `vivaldi.workspaces.list` pref makes a
> Workspace appear in the list but unregistered with Vivaldi's internal sync
> layer, so it renders as "Restored Workspace" instead of the intended name.
> The workflow below works around this by having you create the empty
> Workspaces manually in Vivaldi's UI before populating them via the script.
>
> **Caveat 2:** This path uses the private `vivaldi.*` API surface available
> only inside Vivaldi's own UI context. It can break across Vivaldi versions.
> Your HTML bookmarks are unaffected either way.

**1. Manually create one empty Workspace per Arc Space.**

Open Vivaldi → click the workspace switcher in the tab bar → **New Workspace**
→ type the Arc Space name **exactly** as it appears in Arc → repeat for every
Space you want to import.

This must happen before any script run, because Vivaldi only treats a Workspace
as a real, named entity if the UI created it.

**2. Probe Vivaldi's private API (optional).**

```bash
npx tsx arc-to-vivaldi.ts --probe
```

Open Vivaldi → `chrome://inspect/#apps` → click **inspect** next to
`window.html`. In the DevTools console that opens, paste the contents of
`probe-vivaldi.js`. A JSON blob is printed describing the actual API surface —
useful if a future Vivaldi version moves things around and the importer
template needs adjusting.

**3. Dry-run the importer.**

```bash
npx tsx arc-to-vivaldi.ts --inject-dry-run
```

Paste `vivaldi-import.js` into the same DevTools console. It logs every tab it
*would* create, without making any changes. If any Arc Space title does not
match an existing Vivaldi Workspace name, it aborts with a clear message
listing the missing names.

**4. Run for real.**

```bash
npx tsx arc-to-vivaldi.ts --inject
```

Re-running `--inject` regenerates `vivaldi-import.js` with the dry-run guard
disabled. Paste it into the same DevTools console. The script:

- Reads `vivaldi.workspaces.list` to map each Arc Space title to the Workspace
  ID you created in step 1.
- For each tab: calls `chrome.tabs.create` (the tab briefly appears in
  whichever Workspace is currently active), then immediately calls
  `chrome.tabs.update` with `vivExtData.workspaceId` set to the target — this
  is the call Vivaldi actually honours, and the tab migrates to its proper
  Workspace.
- Calls `chrome.tabs.discard` after each tab to release its renderer
  process immediately. Without this, hundreds of tabs would try to fully
  load in parallel and freeze your system. Discarded tabs still appear in
  the workspace with their URL — they just don't load until you click on
  them.
- Throttles each create-update-discard cycle by 100 ms (tunable via
  `THROTTLE_MS` near the top of the generated file).

**Don't switch Workspaces during the import.** Tabs flicker through whatever
Workspace is active before settling in their target, and switching while the
import runs adds visual chaos. The metadata assignment is correct either way,
but the experience is less alarming if you let it finish in one Workspace.

**Unwinding.** If you want to roll back, run `--unwind-dry-run` to preview, then
`--unwind` to actually close every tab in any Workspace matching an Arc Space
name. The Workspace entries themselves are left intact (you own them — created
them in step 1).

Mapping summary:

| Arc | Vivaldi |
| --- | --- |
| Space | Workspace (you create the empty one in step 1) |
| Pinned column | Pinned tabs in the Workspace |
| Unpinned column (flattened) | Regular tabs in the Workspace |
| Folder hierarchy inside columns | Lost (still preserved in the HTML import) |

### Tab Stacks (folders inside a Workspace)

Vivaldi's Tab Stacks (the equivalent of Arc's nested folders within a Space)
must be created manually. The importer flattens Arc's folder hierarchy when it
builds the paste-able payload, so the structure isn't available at import time.

To recreate stacks: in Vivaldi, Ctrl-click multiple tabs in a Workspace →
right-click → **Stack with Selected** → give the stack a name. Three clicks
per stack.

The full folder hierarchy is still preserved in the HTML bookmarks output, so
if you want navigation by folder, use Vivaldi's Bookmarks panel.

## Notes

- Arc doesn't need to be closed to run this — the file is read-only and Arc
  writes atomically — but for the final import, quit Arc first so any in-memory
  state is flushed to disk.
- HTML entities in titles (`&`, `<`, `>`, `"`) are escaped.
- Tab titles fall back to Arc's `savedTitle` and then to the URL itself if the
  primary `title` field is null (Arc often leaves it null after a session
  restore).
- Items with neither a URL nor any children are dropped silently. Hard parse
  errors (file missing, invalid JSON) exit non-zero; soft issues (dangling
  references, malformed entries) emit a `warn:` line on stderr and continue.

## How it works (briefly)

`sidebar.containers[1].spaces` and `.items` are flat alternating arrays of
`[UUID, object, UUID, object, ...]`. The script pairs them into maps, then for
each Space follows `newContainerIDs` to find the pinned and unpinned root item
IDs, walks each subtree, and renders the result as nested `<DL>`/`<DT>`/`<H3>`
/`<A>` elements per the Netscape format.
