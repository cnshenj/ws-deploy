/** Projects the root lockfile into a filtered deployment lockfile (SPEC §7.4 / FR7-8, Step 6). */

import type {
  ClosureRegistryPackage,
  DependencyMap,
  LockfilePackageEntry,
  NpmLockfile,
  PackageJson,
  RegistryDemand,
  RuntimeClosure,
} from "./types.js";

const NODE_MODULES_PREFIX = "node_modules/";
const NESTED_MARKER = "/node_modules/";

/** The parent hoisting scope of a deployment scope directory (root is `""`). */
function parentScope(scope: string): string {
  const idx = scope.lastIndexOf(NESTED_MARKER);
  // A nested package hoists to its enclosing package; everything else (a
  // top-level `node_modules/*` or a local dep dir) hoists to the root.
  return idx >= 0 ? scope.slice(0, idx) : "";
}

/** Lockfile key for a package `name` placed in `scope`'s `node_modules`. */
function placementKey(scope: string, name: string): string {
  return scope === "" ? `${NODE_MODULES_PREFIX}${name}` : `${scope}${NESTED_MARKER}${name}`;
}

/**
 * Greedy "most-used" hoisting of the registry dependency graph.
 *
 * Every consumer resolves the exact version pinned in the root lockfile; the
 * most-used version of each name is hoisted to the deployment root and conflicting
 * versions are nested under the consumer that needs them. This re-roots the
 * monorepo's layout offline, consistent with npm's lockfile semantics.
 */
class RegistryPlacer {
  /** scope -> (name -> version) placed directly in that scope's node_modules. */
  private readonly placed = new Map<string, Map<string, string>>();
  /** placement keys already expanded (guards cycles and duplicate work). */
  private readonly visited = new Set<string>();
  /** name -> version chosen for the root node_modules. */
  private readonly rootVersion: Map<string, string>;

  constructor(
    private readonly graph: Map<string, ClosureRegistryPackage>,
    private readonly rootLockfile: NpmLockfile,
    private readonly packages: Record<string, LockfilePackageEntry>,
    topDemands: RegistryDemand[],
  ) {
    this.rootVersion = this.computeRootVersions(topDemands);
  }

  /** Place `instanceKey` and its subtree relative to `consumerScope`. */
  place(consumerScope: string, instanceKey: string): void {
    const node = this.graph.get(instanceKey);
    if (!node) {
      return;
    }
    const targetScope = this.chooseScope(consumerScope, node);
    const scopeMap = this.scopeMap(targetScope);
    const existing = scopeMap.get(node.name);
    if (existing === node.version) {
      return; // already placed (and expanded) here
    }
    if (existing !== undefined) {
      // A scope hosts at most one version per name; reaching here is a bug.
      throw new Error(
        `ws-deploy placement conflict: ${node.name}@${existing} vs @${node.version} ` +
          `at "${targetScope || "<root>"}".`,
      );
    }
    scopeMap.set(node.name, node.version);

    const key = placementKey(targetScope, node.name);
    if (this.visited.has(key)) {
      return;
    }
    this.visited.add(key);

    const source = this.rootLockfile.packages[node.lockfileKey];
    if (source) {
      this.packages[key] = { ...source };
    }

    for (const depKey of [...node.dependencies].toSorted()) {
      this.place(key, depKey);
    }
  }

  private scopeMap(scope: string): Map<string, string> {
    let map = this.placed.get(scope);
    if (!map) {
      map = new Map();
      this.placed.set(scope, map);
    }
    return map;
  }

  /** Highest scope on `consumerScope`'s path that can host `node`'s version. */
  private chooseScope(consumerScope: string, node: ClosureRegistryPackage): string {
    for (let scope = consumerScope; ; scope = parentScope(scope)) {
      const version = this.placed.get(scope)?.get(node.name);
      if (version !== undefined) {
        // Nearest ancestor already holds this name: reuse it if the version
        // matches, otherwise this version must nest under the consumer.
        return version === node.version ? scope : consumerScope;
      }
      if (scope === "") {
        break;
      }
    }
    // Not yet on the path: hoist to root if it is the most-used version.
    return this.rootVersion.get(node.name) === node.version ? "" : consumerScope;
  }

  /** Choose the root-level version of each name (most-used; root deps win). */
  private computeRootVersions(topDemands: RegistryDemand[]): Map<string, string> {
    const counts = new Map<string, Map<string, number>>();
    const rootDirect = new Map<string, string>();
    const bump = (name: string, version: string): void => {
      let versions = counts.get(name);
      if (!versions) {
        versions = new Map();
        counts.set(name, versions);
      }
      versions.set(version, (versions.get(version) ?? 0) + 1);
    };

    for (const demand of topDemands) {
      const node = this.graph.get(demand.instanceKey);
      if (!node) {
        continue;
      }
      bump(node.name, node.version);
      if (demand.location === "") {
        rootDirect.set(node.name, node.version); // the root package pins root
      }
    }
    for (const node of this.graph.values()) {
      for (const depKey of node.dependencies) {
        const dep = this.graph.get(depKey);
        if (dep) {
          bump(dep.name, dep.version);
        }
      }
    }

    const rootVersion = new Map<string, string>();
    for (const [name, versions] of counts) {
      const pinned = rootDirect.get(name);
      if (pinned !== undefined) {
        rootVersion.set(name, pinned);
        continue;
      }
      let best: string | undefined;
      let bestCount = -1;
      // Ascending version order makes ties deterministic (NFR1).
      for (const [version, count] of [...versions].toSorted((a, b) => a[0].localeCompare(b[0]))) {
        if (count > bestCount) {
          best = version;
          bestCount = count;
        }
      }
      if (best !== undefined) {
        rootVersion.set(name, best);
      }
    }
    return rootVersion;
  }
}

/** Drop `undefined` values so an npm dependency map becomes a strict string map. */
function toStringMap(map: DependencyMap | undefined): Record<string, string> | undefined {
  if (!map) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(map)) {
    if (spec !== undefined) {
      out[name] = spec;
    }
  }
  return out;
}

/** Build the root ("") package entry from the rewritten deployment manifest. */
function buildRootEntry(rootManifest: PackageJson): LockfilePackageEntry {
  const entry: LockfilePackageEntry = {
    name: rootManifest.name,
    version: rootManifest.version,
  };
  const dependencies = toStringMap(rootManifest.dependencies);
  if (dependencies) {
    entry.dependencies = dependencies;
  }
  const optionalDependencies = toStringMap(rootManifest.optionalDependencies);
  if (optionalDependencies) {
    entry.optionalDependencies = optionalDependencies;
  }
  const peerDependencies = toStringMap(rootManifest.peerDependencies);
  if (peerDependencies) {
    entry.peerDependencies = peerDependencies;
  }
  if (typeof rootManifest.bin === "string") {
    entry.bin = rootManifest.bin;
  } else {
    const bin = toStringMap(rootManifest.bin);
    if (bin) {
      entry.bin = bin;
    }
  }
  return entry;
}

/**
 * Project the root lockfile into a filtered lockfile for the deployment root.
 *
 * The result contains only the closure: the target as root, local
 * dependencies as `file:` links under the deployment's local package directory, and every reachable
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

  // Local (workspace/file) dependencies become deployment-local file links.
  for (const local of closure.localDependencies.values()) {
    packages[`${NODE_MODULES_PREFIX}${local.name}`] = {
      resolved: local.deployRelativePath,
      link: true,
    };
    packages[local.deployRelativePath] = {
      name: local.name,
      version: local.version,
    };
  }

  // Registry dependencies: hoist by most-used version, nesting conflicts.
  const placer = new RegistryPlacer(
    closure.registryPackages,
    rootLockfile,
    packages,
    closure.topDemands,
  );
  // Root demands first, then locals, each in a stable order (NFR1).
  const demands = [...closure.topDemands].toSorted((a, b) => {
    if (a.location !== b.location) {
      if (a.location === "") {
        return -1;
      }
      if (b.location === "") {
        return 1;
      }
      return a.location.localeCompare(b.location);
    }
    return a.instanceKey.localeCompare(b.instanceKey);
  });
  for (const demand of demands) {
    placer.place(demand.location, demand.instanceKey);
  }

  return {
    name: rootManifest.name,
    version: rootManifest.version,
    lockfileVersion,
    requires: true,
    packages,
  };
}
