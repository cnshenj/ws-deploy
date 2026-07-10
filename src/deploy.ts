/** Orchestrates the full ws-deploy pipeline (SPEC §8). */

import * as path from "node:path";

import { computeRuntimeClosure } from "./closure.js";
import { getInstaller } from "./installer.js";
import { loadRootLockfile } from "./lockfile.js";
import { projectLockfile } from "./lockfile-projector.js";
import { materialize } from "./materializer.js";
import type { InstallMode, DeployOptions, DeployResult } from "./types.js";
import { writeJson } from "./util/fsx.js";
import { validateStaging } from "./validate.js";
import { loadWorkspaceGraph, resolveTargetWorkspace } from "./workspace-graph.js";

/**
 * Run ws-deploy end to end for a target workspace.
 */
export async function runWsDeploy(options: DeployOptions): Promise<DeployResult> {
  const installMode: InstallMode = options.installMode ?? "npm-install";
  const warnings: string[] = [];

  // Steps 1-2: discover graph and resolve target.
  const graph = await loadWorkspaceGraph(options.repoRoot);
  const target = resolveTargetWorkspace(graph, options.targetWorkspace);

  // Step 1 (cont.): load the root lockfile (source of truth).
  const rootLockfile = await loadRootLockfile(graph.repoRoot);

  // Step 3: compute the runtime closure.
  const closure = await computeRuntimeClosure(graph, rootLockfile, target, {
    includeDevDependencies: options.includeDevDependencies,
    includeOptionalDependencies: options.includeOptionalDependencies,
    localDepsDir: options.localDepsDir,
  });
  warnings.push(...closure.warnings);

  // Steps 4-5, 7: materialize files and rewrite manifests.
  const materialized = await materialize(closure, {
    stagingDir: options.stagingDir,
    includeDevDependencies: options.includeDevDependencies,
    localDepsDir: options.localDepsDir,
    keepExistingStaging: options.keepExistingStaging,
  });
  warnings.push(...materialized.warnings);

  // Step 6: project the filtered staging lockfile.
  const lockfile = projectLockfile(rootLockfile, closure, materialized.rootManifest);
  await writeJson(path.join(path.resolve(options.stagingDir), "package-lock.json"), lockfile);

  // Step 8: install in staging.
  if (installMode !== "none") {
    const installer = getInstaller();
    await installer.install(path.resolve(options.stagingDir), installMode);
  }

  // Step 9: validate.
  const validation = await validateStaging(path.resolve(options.stagingDir), closure, {
    installed: installMode !== "none",
  });
  if (!validation.ok) {
    throw new Error(`Staging validation failed:\n  - ${validation.errors.join("\n  - ")}`);
  }

  return {
    stagingDir: path.resolve(options.stagingDir),
    closure,
    lockfile,
    warnings,
  };
}
