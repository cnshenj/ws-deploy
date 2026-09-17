/** Repository lockfile reading and node_modules-style resolution (SPEC §7.4 input). */

import * as path from "node:path";

import type { LockfilePackageEntry, NpmLockfile } from "./types.js";
import { pathExists, readJson } from "./filesystem.js";

/** Load the repository npm lockfile. Throws when missing. */
export async function loadRepositoryLockfile(repositoryDir: string): Promise<NpmLockfile> {
  const shrinkwrap = path.join(repositoryDir, "npm-shrinkwrap.json");
  const lockPath = (await pathExists(shrinkwrap))
    ? shrinkwrap
    : path.join(repositoryDir, "package-lock.json");
  if (!(await pathExists(lockPath))) {
    throw new Error(
      `Repository lockfile not found at ${lockPath}. ws-deploy requires a package-lock.json ` +
        `as the source of truth for exact versions.`,
    );
  }
  const lockfile = await readJson<NpmLockfile>(lockPath);
  if (
    !lockfile.packages ||
    typeof lockfile.packages !== "object" ||
    Array.isArray(lockfile.packages)
  ) {
    throw new Error(
      `Repository lockfile ${lockPath} has no "packages" map ` +
        `(lockfileVersion >= 2 is required).`,
    );
  }
  if (!Number.isInteger(lockfile.lockfileVersion) || lockfile.lockfileVersion < 2) {
    throw new Error(`Repository lockfile ${lockPath} requires lockfileVersion >= 2.`);
  }
  return lockfile;
}

/**
 * Resolve a dependency by name from the perspective of a package located at
 * `fromKey` (a lockfile key such as `packages/foo` or `node_modules/somelib`).
 *
 * Mirrors Node's resolution: check `<fromKey>/node_modules/<dep>`, then walk up
 * ancestor directories, finally falling back to top-level `node_modules/<dep>`.
 */
export function resolveLockfileEntry(
  lockfile: NpmLockfile,
  fromKey: string,
  depName: string,
): { key: string; entry: LockfilePackageEntry } | undefined {
  const base = fromKey === "" ? [] : fromKey.split("/");
  // Walk up: try nested node_modules at each ancestor level.
  for (let depth = base.length; depth >= 0; depth--) {
    const prefix = base.slice(0, depth);
    const candidate = [...prefix, "node_modules", depName].join("/");
    const entry = lockfile.packages[candidate];
    if (entry) {
      return { key: candidate, entry };
    }
  }
  return undefined;
}

/** True when a lockfile entry represents a local link (workspace/file dep). */
export function isLinkEntry(entry: LockfilePackageEntry): boolean {
  return entry.link === true;
}
