/** Filesystem helpers used across ws-pack. */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { PackageJson } from "../types.js";

/** Read and parse a JSON file. */
export async function readJson<T = unknown>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

/** Read and parse a `package.json`. */
export async function readManifest(filePath: string): Promise<PackageJson> {
  return readJson<PackageJson>(filePath);
}

/** Write a value as pretty-printed JSON, creating parent directories. */
export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
}

/** Return true when the path exists. */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Return true when the path is an existing directory. */
export async function isDirectory(target: string): Promise<boolean> {
  try {
    const stats = await fs.stat(target);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively copy a package directory into `dest`.
 *
 * `node_modules` is always excluded. When `include` is provided (from a
 * package's `files` allowlist) only matching top-level entries plus the
 * always-included manifest files are copied.
 */
export async function copyPackageDir(src: string, dest: string, include?: string[]): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const includeSet = include && include.length > 0 ? normalizeIncludes(include) : undefined;
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules") {
      continue;
    }
    if (includeSet && !isIncluded(entry.name, includeSet)) {
      continue;
    }
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.cp(from, to, { recursive: true });
    } else {
      await fs.copyFile(from, to);
    }
  }
}

/** Files that must always be copied regardless of a `files` allowlist. */
const ALWAYS_INCLUDED = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "readme",
  "readme.md",
  "license",
  "license.md",
  "licence",
  "licence.md",
]);

function normalizeIncludes(include: string[]): Set<string> {
  const result = new Set<string>();
  for (const pattern of include) {
    // Only the first path segment matters for top-level filtering.
    const trimmed = pattern.replace(/^\.\//, "").replace(/^\//, "");
    const firstSegment = trimmed.split("/")[0];
    if (firstSegment) {
      result.add(firstSegment);
    }
  }
  return result;
}

function isIncluded(name: string, includeSet: Set<string>): boolean {
  if (ALWAYS_INCLUDED.has(name.toLowerCase())) {
    return true;
  }
  return includeSet.has(name);
}

/** Remove a directory tree if it exists. */
export async function removeDir(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}
