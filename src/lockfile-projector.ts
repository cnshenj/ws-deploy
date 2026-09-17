/** Projects the repository lockfile into a filtered deployment lockfile (SPEC §7.4 / FR7-8). */

import * as path from "node:path";

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

/** The parent hoisting scope (`""` is the deployment package scope). */
function parentScope(scope: string): string {
  const idx = scope.lastIndexOf(NESTED_MARKER);
  // A nested package hoists to its enclosing package; everything else (a
  // top-level `node_modules/*` or a local dependency) hoists to the deployment package.
  return idx >= 0 ? scope.slice(0, idx) : "";
}

/** Lockfile key for a package `name` placed in `scope`'s `node_modules`. */
function placementKey(scope: string, name: string): string {
  return scope === "" ? `${NODE_MODULES_PREFIX}${name}` : `${scope}${NESTED_MARKER}${name}`;
}

/**
 * Greedy "most-used" hoisting of the registry dependency graph.
 *
 * Every consumer resolves the exact version pinned in the repository lockfile;
 * the most-used version of each name is hoisted to the deployment's top-level
 * `node_modules`, and conflicting versions are nested under their consumers.
 */
class RegistryPlacer {
  /** scope -> (name -> version) placed directly in that scope's node_modules. */
  private readonly placed = new Map<string, Map<string, string>>();
  /** placement keys already expanded (guards cycles and duplicate work). */
  private readonly visited = new Set<string>();
  /** name -> version chosen for the deployment's top-level node_modules. */
  private readonly deploymentVersions: Map<string, string>;

  constructor(
    private readonly graph: Map<string, ClosureRegistryPackage>,
    private readonly repositoryLockfile: NpmLockfile,
    private readonly packages: Record<string, LockfilePackageEntry>,
    topDemands: RegistryDemand[],
  ) {
    this.deploymentVersions = this.computeDeploymentVersions(topDemands);
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
          `at "${targetScope || "<deployment>"}".`,
      );
    }
    scopeMap.set(node.name, node.version);

    const key = placementKey(targetScope, node.name);
    if (this.visited.has(key)) {
      return;
    }
    this.visited.add(key);

    const source = this.repositoryLockfile.packages[node.lockfileKey];
    if (source) {
      this.packages[key] = { ...source };
    }

    // A peer must be visible from the dependent package, so place it in the
    // same node_modules scope rather than inside the dependent package.
    for (const peerKey of [...node.peerDependencies].toSorted()) {
      this.place(targetScope, peerKey);
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
    // Not yet on the path: hoist to the deployment package if it is the most-used version.
    return this.deploymentVersions.get(node.name) === node.version ? "" : consumerScope;
  }

  /** Choose each top-level deployment version (most-used; direct dependencies win). */
  private computeDeploymentVersions(topDemands: RegistryDemand[]): Map<string, string> {
    const counts = new Map<string, Map<string, number>>();
    const directDeploymentVersions = new Map<string, string>();
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
        directDeploymentVersions.set(node.name, node.version);
      }
    }
    for (const node of this.graph.values()) {
      for (const depKey of [...node.dependencies, ...node.peerDependencies]) {
        const dep = this.graph.get(depKey);
        if (dep) {
          bump(dep.name, dep.version);
        }
      }
    }

    const deploymentVersions = new Map<string, string>();
    for (const [name, versions] of counts) {
      const pinned = directDeploymentVersions.get(name);
      if (pinned !== undefined) {
        deploymentVersions.set(name, pinned);
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
        deploymentVersions.set(name, best);
      }
    }
    return deploymentVersions;
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

/** Build the deployment package entry (`packages[""]`) from its rewritten manifest. */
function buildDeploymentEntry(deploymentManifest: PackageJson): LockfilePackageEntry {
  const entry: LockfilePackageEntry = {
    name: deploymentManifest.name,
    version: deploymentManifest.version,
  };
  const dependencies = toStringMap(deploymentManifest.dependencies);
  if (dependencies) {
    entry.dependencies = dependencies;
  }
  const devDependencies = toStringMap(deploymentManifest.devDependencies);
  if (devDependencies) {
    entry.devDependencies = devDependencies;
  }
  const optionalDependencies = toStringMap(deploymentManifest.optionalDependencies);
  if (optionalDependencies) {
    entry.optionalDependencies = optionalDependencies;
  }
  const peerDependencies = toStringMap(deploymentManifest.peerDependencies);
  if (peerDependencies) {
    entry.peerDependencies = peerDependencies;
  }
  if (typeof deploymentManifest.bin === "string") {
    entry.bin = deploymentManifest.bin;
  } else {
    const bin = toStringMap(deploymentManifest.bin);
    if (bin) {
      entry.bin = bin;
    }
  }
  return entry;
}

/**
 * Project the repository lockfile into a filtered deployment lockfile.
 *
 * The result contains only the closure: the target as the deployment package,
 * local dependencies as `file:` links, and every reachable registry package
 * with exact version/integrity metadata copied from the repository lockfile.
 */
export function projectLockfile(
  repositoryLockfile: NpmLockfile,
  closure: RuntimeClosure,
  deploymentManifest: PackageJson,
  options: { copyLocalPackages?: boolean; deploymentDir?: string } = {},
): NpmLockfile {
  const lockfileVersion =
    repositoryLockfile.lockfileVersion >= 2 ? repositoryLockfile.lockfileVersion : 3;

  const packages: Record<string, LockfilePackageEntry> = {
    "": buildDeploymentEntry(deploymentManifest),
  };
  const copyLocalPackages = options.copyLocalPackages ?? false;
  const deploymentDir = path.resolve(options.deploymentDir ?? ".");

  // Local dependencies are either staged links or packed directly from their source directories.
  for (const local of closure.localDependencies.values()) {
    if (copyLocalPackages) {
      packages[`${NODE_MODULES_PREFIX}${local.name}`] = {
        resolved: local.deploymentRelativePath,
        link: true,
      };
      packages[local.deploymentRelativePath] = {
        name: local.name,
        version: local.version,
      };
    } else {
      let relativeSource = path.relative(deploymentDir, local.sourcePath).replace(/\\/g, "/");
      if (!path.isAbsolute(relativeSource) && !relativeSource.startsWith(".")) {
        relativeSource = `./${relativeSource}`;
      }
      packages[`${NODE_MODULES_PREFIX}${local.name}`] = {
        version: local.version,
        resolved: `file:${relativeSource}`,
      };
    }
  }

  // Registry dependencies: hoist by most-used version, nesting conflicts.
  const placer = new RegistryPlacer(
    closure.registryPackages,
    repositoryLockfile,
    packages,
    closure.topDemands,
  );
  // Deployment package demands first, then locals, each in a stable order (NFR1).
  const localInstallScopes = new Map(
    [...closure.localDependencies.values()].map((local) => [
      local.deploymentRelativePath,
      `${NODE_MODULES_PREFIX}${local.name}`,
    ]),
  );
  const demands = closure.topDemands
    .map((demand) => ({
      ...demand,
      location:
        !copyLocalPackages && demand.location !== ""
          ? (localInstallScopes.get(demand.location) ?? demand.location)
          : demand.location,
    }))
    .toSorted((a, b) => {
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
    name: deploymentManifest.name,
    version: deploymentManifest.version,
    lockfileVersion,
    requires: true,
    packages,
  };
}
