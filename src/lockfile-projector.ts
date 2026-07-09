/** Projects the root lockfile into a filtered staging lockfile (SPEC §7.4 / FR7-8, Step 6). */

import type { LockfilePackageEntry, NpmLockfile, PackageJson, RuntimeClosure } from "./types.js";

const NODE_MODULES_PREFIX = "node_modules/";

/** Rebase a root lockfile key so the target workspace is the staging root. */
function toStagingKey(rootKey: string): string {
  const idx = rootKey.indexOf(NODE_MODULES_PREFIX);
  return idx >= 0 ? rootKey.slice(idx) : rootKey;
}

/** Build the root ("") package entry from the rewritten staging manifest. */
function buildRootEntry(rootManifest: PackageJson): LockfilePackageEntry {
  const entry: LockfilePackageEntry = {
    name: rootManifest.name,
    version: rootManifest.version,
  };
  if (rootManifest.dependencies) {
    entry.dependencies = { ...rootManifest.dependencies };
  }
  if (rootManifest.optionalDependencies) {
    entry.optionalDependencies = { ...rootManifest.optionalDependencies };
  }
  if (rootManifest.peerDependencies) {
    entry.peerDependencies = { ...rootManifest.peerDependencies };
  }
  if (rootManifest.bin) {
    entry.bin = rootManifest.bin;
  }
  return entry;
}

/**
 * Project the root lockfile into a filtered lockfile for the staging root.
 *
 * The result contains only the closure: the target as root, local
 * dependencies as `file:` links under the staging deps dir, and every reachable
 * registry package with its exact version/integrity copied from the root
 * lockfile. Unrelated packages are omitted.
 */
export function projectLockfile(
  rootLockfile: NpmLockfile,
  closure: RuntimeClosure,
  rootManifest: PackageJson,
): NpmLockfile {
  const lockfileVersion = rootLockfile.lockfileVersion >= 2 ? rootLockfile.lockfileVersion : 3;

  const packages: Record<string, LockfilePackageEntry> = {
    "": buildRootEntry(rootManifest),
  };

  // Local (workspace/file) dependencies become staging-local file links.
  for (const local of closure.localDependencies.values()) {
    packages[`${NODE_MODULES_PREFIX}${local.name}`] = {
      resolved: local.stagingRelativePath,
      link: true,
    };
    packages[local.stagingRelativePath] = {
      name: local.name,
      version: local.version,
    };
  }

  // Registry dependencies: copy exact entries from the root lockfile.
  for (const pkg of closure.registryPackages.values()) {
    const source = rootLockfile.packages[pkg.lockfileKey];
    if (!source) {
      continue;
    }
    const stagingKey = toStagingKey(pkg.lockfileKey);
    // Do not clobber a local link entry with a registry entry of the same name.
    if (packages[stagingKey]?.link) {
      continue;
    }
    packages[stagingKey] = { ...source };
  }

  return {
    name: rootManifest.name,
    version: rootManifest.version,
    lockfileVersion,
    requires: true,
    packages,
  };
}
