/**
 * Minimal glob expansion for npm workspace patterns.
 *
 * Supports the subset used by the `workspaces` field: literal path segments,
 * `*` (single segment) and `**` (any depth). `node_modules` and dot-directories
 * are never traversed. Only directories that contain a `package.json` are
 * returned.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Expand a set of workspace patterns rooted at `repoRoot`.
 * Returns absolute directory paths, de-duplicated and sorted.
 */
export async function expandWorkspacePatterns(
  repoRoot: string,
  patterns: string[],
): Promise<string[]> {
  const results = new Set<string>();
  for (const pattern of patterns) {
    const normalized = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized || normalized.startsWith("!")) {
      continue; // negation patterns are not supported
    }
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    await walk(repoRoot, segments, results);
  }
  return [...results].toSorted();
}

async function walk(currentDir: string, segments: string[], results: Set<string>): Promise<void> {
  if (segments.length === 0) {
    if (await hasManifest(currentDir)) {
      results.add(currentDir);
    }
    return;
  }

  const [head, ...rest] = segments;
  if (head === undefined) {
    return;
  }

  if (head === "**") {
    // `**` matches zero or more directories.
    await walk(currentDir, rest, results);
    for (const child of await listDirs(currentDir)) {
      await walk(child, segments, results);
    }
    return;
  }

  if (head === "*") {
    for (const child of await listDirs(currentDir)) {
      await walk(child, rest, results);
    }
    return;
  }

  const next = path.join(currentDir, head);
  if (await isDir(next)) {
    await walk(next, rest, results);
  }
}

async function listDirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    dirs.push(path.join(dir, entry.name));
  }
  return dirs;
}

async function isDir(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function hasManifest(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(dir, "package.json"))).isFile();
  } catch {
    return false;
  }
}
