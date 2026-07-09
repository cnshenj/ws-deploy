/** Classifies dependency declarations into workspace / file / registry / etc. */

import type { DependencyEdge, DependencyGroup, DependencyKind, PackageJson } from "./types.js";

const WORKSPACE_PROTOCOL = /^workspace:/;
const FILE_PROTOCOL = /^(file:|link:)/;

/**
 * Classify a single dependency specifier.
 *
 * A dependency is treated as a workspace dependency when it uses the
 * `workspace:` protocol or its name matches a known workspace package
 * (npm resolves such names to the local workspace). `file:`/`link:`
 * specifiers are file dependencies. Everything else is a registry dependency.
 */
export function classifyDependency(
  depName: string,
  specifier: string,
  workspaceNames: ReadonlySet<string>,
): DependencyKind {
  if (WORKSPACE_PROTOCOL.test(specifier)) {
    return "workspace";
  }
  if (FILE_PROTOCOL.test(specifier)) {
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
  section: Record<string, string> | undefined,
  group: DependencyGroup,
  workspaceNames: ReadonlySet<string>,
): DependencyEdge[] {
  if (!section) {
    return [];
  }
  const edges: DependencyEdge[] = [];
  for (const [depName, specifier] of Object.entries(section)) {
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
