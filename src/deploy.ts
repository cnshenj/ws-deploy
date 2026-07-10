/** Orchestrates the full ws-deploy pipeline (SPEC §8). */

import * as path from "node:path";

import { computeRuntimeClosure } from "./closure.js";
import { getInstaller } from "./installer.js";
import { loadRootLockfile } from "./lockfile.js";
import { projectLockfile } from "./lockfile-projector.js";
import { materialize } from "./materializer.js";
import {
  DEFAULT_INSTALL_MODE,
  type InstallMode,
  type DeployOptions,
  type DeployResult,
} from "./types.js";
import { writeJson } from "./util/fsx.js";
import { validateDeployment } from "./validate.js";
import { loadWorkspaceGraph, resolveTargetWorkspace } from "./workspace-graph.js";

/**
 * Run ws-deploy end to end for a target workspace.
 */
export async function runWsDeploy(options: DeployOptions): Promise<DeployResult> {
  const installMode: InstallMode = options.installMode ?? DEFAULT_INSTALL_MODE;
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
  });
  warnings.push(...closure.warnings);

  // Steps 4-5, 7: materialize files and rewrite manifests.
  const materialized = await materialize(closure, {
    deployDir: options.deployDir,
    includeDevDependencies: options.includeDevDependencies,
    keepExistingDeployDir: options.keepExistingDeployDir,
  });
  warnings.push(...materialized.warnings);

  // Step 6: project the filtered deployment lockfile.
  const lockfile = projectLockfile(rootLockfile, closure, materialized.rootManifest);
  await writeJson(path.join(path.resolve(options.deployDir), "package-lock.json"), lockfile);

  // Step 8: install in the deployment directory.
  if (installMode !== "none") {
    const installer = getInstaller();
    await installer.install(path.resolve(options.deployDir), installMode);
  }

  // Step 9: validate.
  const validation = await validateDeployment(path.resolve(options.deployDir), closure, {
    installed: installMode !== "none",
  });
  if (!validation.ok) {
    throw new Error(`Deployment validation failed:\n  - ${validation.errors.join("\n  - ")}`);
  }

  return {
    deployDir: path.resolve(options.deployDir),
    closure,
    lockfile,
    warnings,
  };
}
