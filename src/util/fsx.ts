/** Filesystem helpers used across ws-pack. */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import packlist from "npm-packlist";

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
 * Copy a package directory into `dest`, honoring npm's own packing rules.
 *
 * The file set is computed by `npm-packlist`, the same library npm uses for
 * `npm pack`, so the copy respects the `files` allowlist, `.npmignore` /
 * `.gitignore`, and npm's always-included files (`package.json`, `README`,
 * `LICENSE`, etc.). `node_modules` is excluded by npm-packlist's defaults.
 */
export async function copyPackageDir(
  src: string,
  dest: string,
  manifest: PackageJson,
): Promise<void> {
  // npm-packlist accepts a lightweight `{ path, package }` tree at runtime, but
  // its types model only the full Arborist `Node`, so cast the tree through unknown.
  const tree = { path: src, package: manifest, isProjectRoot: true };
  const files = await packlist(tree as unknown as Parameters<typeof packlist>[0]);
  await fs.mkdir(dest, { recursive: true });
  for (const relative of files) {
    const from = path.join(src, relative);
    const to = path.join(dest, relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
}
export async function removeDir(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}
