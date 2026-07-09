/** Classifies dependency declarations into workspace / file / registry / etc. */

import npa from "npm-package-arg";

import type {
  DependencyEdge,
  DependencyGroup,
  DependencyKind,
  DependencyMap,
  PackageJson,
} from "./types.js";

const WORKSPACE_PROTOCOL = /^workspace:/;

/**
 * Classify a single dependency specifier.
 *
 * The `workspace:` protocol and specifiers whose name matches a known workspace
 * package resolve to workspace dependencies. Local `file:`/`link:` specifiers
 * (and any other unsupported protocol) are file dependencies. Everything that
 * `npm-package-arg` resolves as a registry/git/remote/alias spec is treated as
 * a registry dependency and left for the lockfile to resolve.
 */
export function classifyDependency(
  depName: string,
  specifier: string,
  workspaceNames: ReadonlySet<string>,
): DependencyKind {
  if (WORKSPACE_PROTOCOL.test(specifier)) {
    return "workspace";
  }

  let parsed: npa.Result | undefined;
  try {
    parsed = npa.resolve(depName, specifier);
  } catch {
    // Unsupported protocol such as `link:` — treat as a local file dependency.
    return "file";
  }

  if (parsed.type === "file" || parsed.type === "directory") {
    return "file";
  }
  if (workspaceNames.has(depName)) {
    return "workspace";
  }
  return "registry";
}

/** Build classified edges for one manifest section. */
export function buildEdges(
  fromPackage: string,
  section: DependencyMap | undefined,
  group: DependencyGroup,
  workspaceNames: ReadonlySet<string>,
): DependencyEdge[] {
  if (!section) {
    return [];
  }
  const edges: DependencyEdge[] = [];
  for (const [depName, specifier] of Object.entries(section)) {
    if (specifier === undefined) {
      continue;
    }
    const kind =
      group === "peer"
        ? "peer"
        : group === "dev"
          ? "dev"
          : classifyDependency(depName, specifier, workspaceNames);
    edges.push({ fromPackage, depName, specifier, kind, group });
  }
  return edges;
}

/** Build the full set of classified edges for a manifest. */
export function classifyManifest(
  fromPackage: string,
  manifest: PackageJson,
  workspaceNames: ReadonlySet<string>,
): {
  dependencies: DependencyEdge[];
  devDependencies: DependencyEdge[];
  peerDependencies: DependencyEdge[];
  optionalDependencies: DependencyEdge[];
} {
  return {
    dependencies: buildEdges(fromPackage, manifest.dependencies, "prod", workspaceNames),
    devDependencies: buildEdges(fromPackage, manifest.devDependencies, "dev", workspaceNames),
    peerDependencies: buildEdges(fromPackage, manifest.peerDependencies, "peer", workspaceNames),
    optionalDependencies: buildEdges(
      fromPackage,
      manifest.optionalDependencies,
      "optional",
      workspaceNames,
    ),
  };
}
