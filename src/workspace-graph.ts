/** Discovers the monorepo workspace graph (SPEC §7.1 / FR2). */

import * as path from "node:path";

import mapWorkspaces from "@npmcli/map-workspaces";

import { classifyManifest } from "./dependency-classifier.js";
import type { WorkspaceGraph, WorkspaceNode } from "./types.js";
import { readManifest } from "./filesystem.js";

/**
 * Load the workspace graph for a monorepo.
 *
 * Reads the repository manifest, resolves the `workspaces` patterns via
 * `@npmcli/map-workspaces` (npm's own resolver), parses each package manifest,
 * and classifies dependency edges against the discovered workspace name set.
 */
export async function loadWorkspaceGraph(repositoryDir: string): Promise<WorkspaceGraph> {
  const resolvedRepositoryDir = path.resolve(repositoryDir);
  const repositoryManifestPath = path.join(resolvedRepositoryDir, "package.json");
  const repositoryManifest = await readManifest(repositoryManifestPath);

  const workspaceMap = await mapWorkspaces({ cwd: resolvedRepositoryDir, pkg: repositoryManifest });
  const workspaceNames = new Set(workspaceMap.keys());

  const nodes = new Map<string, WorkspaceNode>();
  for (const [name, dir] of workspaceMap) {
    const manifestPath = path.join(dir, "package.json");
    const manifest = await readManifest(manifestPath);
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

  return { repositoryDir: resolvedRepositoryDir, repositoryManifest, nodes };
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
      `Target workspace "${targetWorkspace}" not found in ${graph.repositoryDir}. ` +
        `Available workspaces: ${available}.`,
    );
  }
  return node;
}
