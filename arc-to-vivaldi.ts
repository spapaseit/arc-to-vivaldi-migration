#!/usr/bin/env tsx
/**
 * Convert Arc Browser's StorableSidebar.json into a Netscape-format
 * bookmarks HTML file suitable for import into Vivaldi.
 *
 *   tsx arc-to-vivaldi.ts [--input <path>] [--output <path>] [-v]
 */

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import type {
  ArcSpace,
  ArcSpaceCustomInfo,
  ArcItem,
  ArcTabData,
  BookmarkNode,
  SpaceConversion,
} from "./lib/types.js";
import { parseArgs } from "./lib/cli.js";
import { buildInjectablePayload } from "./lib/payload.js";
import { renderProbeScript } from "./lib/render-probe.js";
import { renderInjectScript } from "./lib/render-inject.js";
import { renderUnwindScript } from "./lib/render-unwind.js";

// ---------- Helpers ----------

function warn(msg: string): void {
  process.stderr.write(`warn: ${msg}\n`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(s: string): string {
  const stripped = s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stripped.length > 0 ? stripped : "untitled";
}

function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

// ---------- CLI ----------

async function autoDiscoverInput(): Promise<string> {
  const localAppData = process.env["LOCALAPPDATA"];
  if (localAppData === undefined) {
    throw new Error("LOCALAPPDATA env var not set; pass --input explicitly");
  }
  const packagesDir = join(localAppData, "Packages");
  const entries = await readdir(packagesDir);
  const arcDirs = entries.filter((e) => e.startsWith("TheBrowserCompany.Arc_"));
  if (arcDirs.length === 0) {
    throw new Error(`no TheBrowserCompany.Arc_* directory under ${packagesDir}`);
  }
  for (const dir of arcDirs) {
    const candidate = join(
      packagesDir,
      dir,
      "LocalCache",
      "Local",
      "Arc",
      "StorableSidebar.json",
    );
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no StorableSidebar.json found under any Arc package directory");
}

// ---------- JSON → typed model ----------

interface ParsedSidebar {
  readonly spaces: ReadonlyMap<string, ArcSpace>;
  readonly items: ReadonlyMap<string, ArcItem>;
  readonly spaceOrder: readonly string[];
}

function parseSidebar(raw: unknown): ParsedSidebar {
  if (!isRecord(raw)) throw new Error("root is not an object");
  const sidebar = raw["sidebar"];
  if (!isRecord(sidebar)) throw new Error("missing or invalid 'sidebar'");
  const containers = sidebar["containers"];
  if (!Array.isArray(containers) || containers.length < 2) {
    throw new Error("expected sidebar.containers to be an array of length >= 2");
  }
  const real = containers[1];
  if (!isRecord(real)) throw new Error("containers[1] is not an object");
  const rawSpaces = real["spaces"];
  const rawItems = real["items"];
  if (!Array.isArray(rawSpaces)) throw new Error("containers[1].spaces is not an array");
  if (!Array.isArray(rawItems)) throw new Error("containers[1].items is not an array");

  const spacesPaired = pairAlternating(rawSpaces, narrowSpace);
  const itemsPaired = pairAlternating(rawItems, narrowItem);
  return {
    spaces: spacesPaired.map,
    items: itemsPaired.map,
    spaceOrder: spacesPaired.order,
  };
}

interface PairedResult<T> {
  readonly map: ReadonlyMap<string, T>;
  readonly order: readonly string[];
}

function pairAlternating<T>(
  arr: readonly unknown[],
  narrow: (v: unknown, id: string) => T | undefined,
): PairedResult<T> {
  const map = new Map<string, T>();
  const order: string[] = [];
  for (let i = 0; i + 1 < arr.length; i += 2) {
    const id = arr[i];
    const obj = arr[i + 1];
    if (typeof id !== "string") {
      warn(`expected string id at index ${i}, got ${typeof id}`);
      continue;
    }
    const narrowed = narrow(obj, id);
    if (narrowed === undefined) continue;
    map.set(id, narrowed);
    order.push(id);
  }
  return { map, order };
}

function narrowSpace(v: unknown, id: string): ArcSpace | undefined {
  if (!isRecord(v)) {
    warn(`space ${id} is not an object`);
    return undefined;
  }
  const title = asString(v["title"]) ?? "";
  const newContainerIDs = v["newContainerIDs"];
  if (!Array.isArray(newContainerIDs)) {
    warn(`space ${id} missing newContainerIDs`);
    return undefined;
  }
  let customInfo: ArcSpaceCustomInfo | undefined;
  const customInfoRaw = v["customInfo"];
  if (isRecord(customInfoRaw)) {
    const iconTypeRaw = customInfoRaw["iconType"];
    if (isRecord(iconTypeRaw)) {
      customInfo = { iconType: { icon: asString(iconTypeRaw["icon"]) } };
    } else {
      customInfo = { iconType: undefined };
    }
  }
  return { id, title, customInfo, newContainerIDs };
}

function narrowItem(v: unknown, id: string): ArcItem | undefined {
  if (!isRecord(v)) {
    warn(`item ${id} is not an object`);
    return undefined;
  }
  const titleRaw = v["title"];
  const title: string | null = typeof titleRaw === "string" ? titleRaw : null;
  const parentID = asString(v["parentID"]);

  const childrenIds: string[] = [];
  const childrenIdsRaw = v["childrenIds"];
  if (Array.isArray(childrenIdsRaw)) {
    for (const c of childrenIdsRaw) {
      if (typeof c === "string") childrenIds.push(c);
    }
  }

  let tab: ArcTabData | undefined;
  let isList = false;
  const dataRaw = v["data"];
  if (isRecord(dataRaw)) {
    const tabRaw = dataRaw["tab"];
    if (isRecord(tabRaw)) {
      tab = {
        savedURL: asString(tabRaw["savedURL"]),
        savedTitle: asString(tabRaw["savedTitle"]),
      };
    }
    isList = "list" in dataRaw;
  }
  return { id, title, parentID, childrenIds, data: { tab, isList } };
}

// ---------- Container root extraction ----------

interface ContainerRootIds {
  readonly pinned: string | undefined;
  readonly unpinned: string | undefined;
}

function extractContainerRoots(newContainerIDs: readonly unknown[]): ContainerRootIds {
  let pinned: string | undefined;
  let unpinned: string | undefined;
  for (let i = 0; i + 1 < newContainerIDs.length; i += 2) {
    const marker = newContainerIDs[i];
    const id = newContainerIDs[i + 1];
    if (!isRecord(marker) || typeof id !== "string") continue;
    if ("pinned" in marker && pinned === undefined) pinned = id;
    else if ("unpinned" in marker && unpinned === undefined) unpinned = id;
  }
  return { pinned, unpinned };
}

// ---------- Tree walk ----------

interface BuildStats {
  bookmarks: number;
  folders: number;
}

function buildSubtree(
  rootId: string | undefined,
  items: ReadonlyMap<string, ArcItem>,
  stats: BuildStats,
  visited: Set<string>,
): readonly BookmarkNode[] {
  if (rootId === undefined) return [];
  const root = items.get(rootId);
  if (root === undefined) {
    warn(`container root ${rootId} not found in items`);
    return [];
  }
  return walkChildren(root.childrenIds, items, stats, visited);
}

function walkChildren(
  ids: readonly string[],
  items: ReadonlyMap<string, ArcItem>,
  stats: BuildStats,
  visited: Set<string>,
): readonly BookmarkNode[] {
  const nodes: BookmarkNode[] = [];
  for (const childId of ids) {
    if (visited.has(childId)) {
      warn(`cycle detected at ${childId}, skipping`);
      continue;
    }
    visited.add(childId);
    const child = items.get(childId);
    if (child === undefined) {
      warn(`dangling childId ${childId}`);
      continue;
    }
    const url = child.data.tab?.savedURL;
    if (typeof url === "string" && url.length > 0) {
      const explicit = child.title?.trim();
      const saved = child.data.tab?.savedTitle?.trim();
      const title = (explicit && explicit.length > 0)
        ? explicit
        : (saved && saved.length > 0) ? saved : url;
      nodes.push({ kind: "leaf", title, url });
      stats.bookmarks++;
      continue;
    }
    const grandchildren = walkChildren(child.childrenIds, items, stats, visited);
    if (grandchildren.length === 0) {
      // Orphan: neither URL nor children with content. Drop quietly.
      continue;
    }
    const rawTitle = child.title?.trim();
    const folderTitle = (rawTitle && rawTitle.length > 0) ? rawTitle : "Untitled";
    nodes.push({ kind: "folder", title: folderTitle, children: grandchildren });
    stats.folders++;
  }
  return nodes;
}

// ---------- HTML rendering ----------

function renderTree(nodes: readonly BookmarkNode[], indent: number): string {
  const pad = "    ".repeat(indent);
  const childPad = "    ".repeat(indent + 1);
  const lines: string[] = [`${pad}<DL><p>`];
  for (const n of nodes) {
    if (n.kind === "leaf") {
      lines.push(`${childPad}<DT><A HREF="${htmlEscape(n.url)}">${htmlEscape(n.title)}</A>`);
    } else {
      lines.push(`${childPad}<DT><H3>${htmlEscape(n.title)}</H3>`);
      lines.push(renderTree(n.children, indent + 1));
    }
  }
  lines.push(`${pad}</DL><p>`);
  return lines.join("\n");
}

function renderDocument(spaces: readonly SpaceConversion[]): string {
  const lines: string[] = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    `<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">`,
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  for (const space of spaces) {
    const iconComment = space.iconHint !== undefined
      ? ` <!-- icon: ${htmlEscape(space.iconHint)} -->`
      : "";
    lines.push(`    <DT><H3>${htmlEscape(space.title)}</H3>${iconComment}`);
    lines.push("    <DL><p>");
    lines.push("        <DT><H3>Pinned</H3>");
    lines.push(renderTree(space.pinned, 2));
    lines.push("        <DT><H3>Unpinned</H3>");
    lines.push(renderTree(space.unpinned, 2));
    lines.push("    </DL><p>");
  }
  lines.push("</DL><p>");
  return lines.join("\n") + "\n";
}

// ---------- Main ----------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "usage: tsx arc-to-vivaldi.ts [--input <path>] [--output <path>]\n" +
        "                            [--split | --probe | --inject | --inject-dry-run]\n" +
        "                            [-v]\n" +
        "  HTML modes (default): --split is allowed.\n" +
        "  JS payload modes: --probe, --inject, --inject-dry-run are mutually exclusive\n" +
        "    and cannot be combined with --split.\n",
    );
    return 0;
  }
  if (args.mode === "probe") {
    const outPath = args.output ?? "./probe-vivaldi.js";
    await writeFile(outPath, renderProbeScript(), "utf8");
    process.stderr.write(
      `probe script written to ${outPath}\n` +
        `paste it into Vivaldi's internal DevTools (chrome://inspect/#apps -> click 'inspect' next to window.html)\n`,
    );
    return 0;
  }

  const inputPath = args.input ?? (await autoDiscoverInput());

  let raw: string;
  try {
    raw = await readFile(inputPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `error: cannot read ${inputPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `error: failed to parse JSON: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const { spaces, items, spaceOrder } = parseSidebar(parsed);

  let untitledCounter = 0;
  let totalBookmarks = 0;
  let totalFolders = 0;
  const conversions: SpaceConversion[] = [];

  for (const spaceId of spaceOrder) {
    const space = spaces.get(spaceId);
    if (space === undefined) continue;
    const title = space.title.trim() || `Untitled Space ${++untitledCounter}`;
    const roots = extractContainerRoots(space.newContainerIDs);
    const stats: BuildStats = { bookmarks: 0, folders: 0 };
    const visited = new Set<string>();
    const pinned = buildSubtree(roots.pinned, items, stats, visited);
    const unpinned = buildSubtree(roots.unpinned, items, stats, visited);
    if (pinned.length === 0 && unpinned.length === 0) {
      warn(`space "${title}" has no bookmarks; skipping`);
      continue;
    }
    conversions.push({
      title,
      iconHint: space.customInfo?.iconType?.icon,
      pinned,
      unpinned,
      bookmarkCount: stats.bookmarks,
      folderCount: stats.folders,
    });
    totalBookmarks += stats.bookmarks;
    totalFolders += stats.folders;
  }

  if (args.mode === "inject" || args.mode === "inject-dry-run") {
    const outPath = args.output ?? "./vivaldi-import.js";
    const payload = buildInjectablePayload(conversions, {
      sourcePath: inputPath,
      now: new Date(),
    });
    const script = renderInjectScript(payload, {
      dryRun: args.mode === "inject-dry-run",
    });
    const totalTabs = payload.spaces.reduce(
      (acc, s) => acc + s.pinned.length + s.unpinned.length,
      0,
    );
    await writeFile(outPath, script, "utf8");
    process.stderr.write(
      `${payload.spaces.length} spaces, ${totalTabs} tabs embedded in ${outPath}` +
        (args.mode === "inject-dry-run" ? " (dry-run mode)" : "") +
        "\n",
    );
    return 0;
  }

  if (args.mode === "unwind" || args.mode === "unwind-dry-run") {
    const outPath = args.output ?? "./vivaldi-unwind.js";
    const payload = buildInjectablePayload(conversions, {
      sourcePath: inputPath,
      now: new Date(),
    });
    const script = renderUnwindScript(payload, {
      dryRun: args.mode === "unwind-dry-run",
    });
    await writeFile(outPath, script, "utf8");
    process.stderr.write(
      `unwind script (matches ${payload.spaces.length} space names) written to ${outPath}` +
        (args.mode === "unwind-dry-run" ? " (dry-run mode)" : "") +
        "\n",
    );
    return 0;
  }

  // args.mode === "html" — existing behaviour below.
  const writtenPaths: string[] = [];
  if (args.split) {
    const outDir = args.output ?? ".";
    await mkdir(outDir, { recursive: true });
    const taken = new Set<string>();
    for (const c of conversions) {
      const slug = uniqueSlug(slugify(c.title), taken);
      const filePath = join(outDir, `arc-${slug}.html`);
      await writeFile(filePath, renderDocument([c]), "utf8");
      writtenPaths.push(filePath);
      if (args.verbose) {
        process.stderr.write(
          `  ${c.title}: ${c.bookmarkCount} bookmarks, ${c.folderCount} folders → ${filePath}\n`,
        );
      }
    }
  } else {
    const outPath = args.output ?? "./arc-bookmarks.html";
    await writeFile(outPath, renderDocument(conversions), "utf8");
    writtenPaths.push(outPath);
    if (args.verbose) {
      for (const c of conversions) {
        process.stderr.write(
          `  ${c.title}: ${c.bookmarkCount} bookmarks, ${c.folderCount} folders\n`,
        );
      }
    }
  }

  const destination = args.split
    ? `${writtenPaths.length} files in ${args.output ?? "."}`
    : (writtenPaths[0] ?? "(no output)");
  process.stderr.write(
    `${conversions.length} spaces, ${totalBookmarks} bookmarks, ${totalFolders} folders → ${destination}\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  },
);
