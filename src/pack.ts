/** Orchestrates the full ws-pack pipeline (SPEC §8). */

import * as path from "node:path";

import { createArchive } from "./archive.js";
import { computeRuntimeClosure } from "./closure.js";
import { getInstaller } from "./installer.js";
import { loadRootLockfile } from "./lockfile.js";
import { projectLockfile } from "./lockfile-projector.js";
import { materialize } from "./materializer.js";
import type { InstallMode, PackOptions, PackResult } from "./types.js";
import { writeJson } from "./util/fsx.js";
import { validateStaging } from "./validate.js";
import { loadWorkspaceGraph, resolveTargetWorkspace } from "./workspace-graph.js";

/** Default archive file name for a target/format. */
function defaultArchivePath(stagingDir: string, targetName: string, format: string): string {
  const base = targetName.replace(/[@/]/g, "-").replace(/^-+/, "");
  const ext = format === "zip" ? "zip" : "tgz";
  return path.join(path.dirname(path.resolve(stagingDir)), `${base}.${ext}`);
}

/**
 * Run ws-pack end to end for a target workspace.
 */
export async function runWsPack(options: PackOptions): Promise<PackResult> {
  const installMode: InstallMode = options.installMode ?? "npm-install";
  const archiveFormat = options.archive ?? "none";
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

  // Step 10: archive.
  let archivePath: string | undefined;
  if (archiveFormat !== "none") {
    const outPath = defaultArchivePath(options.stagingDir, target.name, archiveFormat);
    archivePath = await createArchive(path.resolve(options.stagingDir), archiveFormat, outPath);
  }

  return {
    stagingDir: path.resolve(options.stagingDir),
    closure,
    lockfile,
    archivePath,
    warnings,
  };
}
