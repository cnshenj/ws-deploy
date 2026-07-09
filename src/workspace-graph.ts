/** Discovers the monorepo workspace graph (SPEC §7.1 / FR2). */

import * as path from "node:path";

import { classifyManifest } from "./dependency-classifier.js";
import type { PackageJson, WorkspaceGraph, WorkspaceNode } from "./types.js";
import { readManifest } from "./util/fsx.js";
import { expandWorkspacePatterns } from "./util/glob.js";

/** Extract workspace glob patterns from a root manifest. */
export function getWorkspacePatterns(rootManifest: PackageJson): string[] {
  const { workspaces } = rootManifest;
  if (!workspaces) {
    return [];
  }
  if (Array.isArray(workspaces)) {
    return workspaces;
  }
  return workspaces.packages ?? [];
}

/**
 * Load the workspace graph for a monorepo.
 *
 * Reads the root manifest, expands the `workspaces` patterns, parses each
 * package manifest, and classifies dependency edges against the discovered
 * workspace name set.
 */
export async function loadWorkspaceGraph(repoRoot: string): Promise<WorkspaceGraph> {
  const absRoot = path.resolve(repoRoot);
  const rootManifestPath = path.join(absRoot, "package.json");
  const rootManifest = await readManifest(rootManifestPath);

  const patterns = getWorkspacePatterns(rootManifest);
  const packageDirs = await expandWorkspacePatterns(absRoot, patterns);

  // First pass: read manifests and collect workspace names.
  const raw: { dir: string; manifestPath: string; manifest: PackageJson }[] = [];
  const workspaceNames = new Set<string>();
  for (const dir of packageDirs) {
    const manifestPath = path.join(dir, "package.json");
    const manifest = await readManifest(manifestPath);
    if (!manifest.name) {
      continue; // unnamed packages cannot be referenced as workspace deps
    }
    raw.push({ dir, manifestPath, manifest });
    workspaceNames.add(manifest.name);
  }

  // Second pass: build classified nodes.
  const nodes = new Map<string, WorkspaceNode>();
  for (const { dir, manifestPath, manifest } of raw) {
    const name = manifest.name as string;
    const classified = classifyManifest(name, manifest, workspaceNames);
    nodes.set(name, {
      name,
      version: manifest.version ?? "0.0.0",
      path: dir,
      manifestPath,
      manifest,
      dependencies: classified.dependencies,
      devDependencies: classified.devDependencies,
      peerDependencies: classified.peerDependencies,
      optionalDependencies: classified.optionalDependencies,
    });
  }

  return { repoRoot: absRoot, rootManifest, nodes };
}

/** Resolve the target workspace node, failing early when missing (SPEC Step 2). */
export function resolveTargetWorkspace(
  graph: WorkspaceGraph,
  targetWorkspace: string,
): WorkspaceNode {
  const node = graph.nodes.get(targetWorkspace);
  if (!node) {
    const available = [...graph.nodes.keys()].toSorted().join(", ") || "(none)";
    throw new Error(
      `Target workspace "${targetWorkspace}" not found in ${graph.repoRoot}. ` +
        `Available workspaces: ${available}.`,
    );
  }
  return node;
}
