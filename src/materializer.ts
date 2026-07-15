/** Materializes the deployment tree: copy files + rewrite manifests (SPEC §7.5 / FR3-5, Step 7). */

import * as path from "node:path";

import type { PackageJson, DeployOptions, RuntimeClosure, DeployLocalDependency } from "./types.js";
import { copyPackageDir, isDirectory, removeDir, writeJson } from "./filesystem.js";

export interface MaterializeResult {
  /** The rewritten deployment package manifest. */
  deploymentManifest: PackageJson;
  warnings: string[];
}

const WORKSPACE_OR_FILE = /^(workspace:|file:|link:)/;

/** Normalize a package name into its filesystem sub-path (keeps scopes). */
function deploymentSubPath(name: string): string {
  return name;
}

/** Compute a `file:` reference from `manifestRelDir` to a local package's deployment directory. */
function computeLocalReference(manifestRelDir: string, dependencyDeploymentPath: string): string {
  const rel = path.relative(manifestRelDir || ".", dependencyDeploymentPath).replace(/\\/g, "/");
  const normalized = rel.startsWith(".") ? rel : `./${rel}`;
  return `file:${normalized}`;
}

/** Rewrite a manifest so local deps point at deployment-local `file:` paths. */
function rewriteManifest(
  manifest: PackageJson,
  manifestRelDir: string,
  closure: RuntimeClosure,
  options: { includeDev: boolean; isDeploymentManifest: boolean },
  warnings: string[],
): PackageJson {
  const rewritten: PackageJson = { ...manifest };

  // The standalone deployment package must not retain workspace configuration.
  delete rewritten.workspaces;

  const sections: Array<"dependencies" | "optionalDependencies" | "devDependencies"> = [
    "dependencies",
    "optionalDependencies",
  ];
  if (options.isDeploymentManifest && options.includeDev) {
    sections.push("devDependencies");
  }
  for (const section of sections) {
    const original = manifest[section];
    if (!original) {
      continue;
    }
    const next: Record<string, string> = {};
    for (const [name, spec] of Object.entries(original)) {
      const local = closure.localDependencies.get(name);
      if (local) {
        next[name] = computeLocalReference(manifestRelDir, local.deploymentRelativePath);
      } else if (spec === undefined) {
        continue;
      } else if (WORKSPACE_OR_FILE.test(spec)) {
        warnings.push(
          `Dropped unresolved ${section} entry "${name}": "${spec}" ` +
            `in ${manifestRelDir || "<deployment>"} (not part of the runtime closure).`,
        );
      } else {
        next[name] = spec; // registry dependency, left untouched
      }
    }
    rewritten[section] = next;
  }

  // devDependencies are prod-irrelevant in the deployment.
  if (!(options.isDeploymentManifest && options.includeDev)) {
    delete rewritten.devDependencies;
  }

  return rewritten;
}

/**
 * Materialize the deployment tree for a closure.
 *
 * 1. (Re)create the deployment directory.
 * 2. Copy the target workspace files into the deployment directory.
 * 3. Copy each local dependency into `local-packages/<name>`.
 * 4. Rewrite the deployment manifest and every local manifest so workspace/file
 *    specifiers point at deployment-local `file:` references.
 */
export async function materialize(
  closure: RuntimeClosure,
  repositoryManifest: PackageJson,
  options: Pick<
    DeployOptions,
    "deploymentDir" | "includeDevDependencies" | "keepExistingDeploymentDir"
  >,
): Promise<MaterializeResult> {
  const deploymentDir = path.resolve(options.deploymentDir);
  const warnings: string[] = [];

  if (!options.keepExistingDeploymentDir && (await isDirectory(deploymentDir))) {
    await removeDir(deploymentDir);
  }

  // Copy the target workspace into the deployment directory.
  await copyPackageDir(closure.target.path, deploymentDir, closure.target.manifest);

  // Copy each local dependency.
  for (const local of closure.localDependencies.values()) {
    const dest = path.join(deploymentDir, ...local.deploymentRelativePath.split("/"));
    await copyLocalDependency(local, dest);
  }

  // Rewrite the deployment manifest.
  const deploymentManifest = rewriteManifest(
    closure.target.manifest,
    "",
    closure,
    { includeDev: options.includeDevDependencies ?? false, isDeploymentManifest: true },
    warnings,
  );
  const repositoryOverrides = repositoryManifest["overrides"];
  if (repositoryOverrides === undefined) {
    delete deploymentManifest["overrides"];
  } else {
    deploymentManifest["overrides"] = repositoryOverrides;
  }
  await writeJson(path.join(deploymentDir, "package.json"), deploymentManifest);

  // Rewrite each local dependency manifest.
  for (const local of closure.localDependencies.values()) {
    const manifestRelDir = local.deploymentRelativePath;
    const rewritten = rewriteManifest(
      local.manifest,
      manifestRelDir,
      closure,
      { includeDev: false, isDeploymentManifest: false },
      warnings,
    );
    await writeJson(
      path.join(deploymentDir, ...manifestRelDir.split("/"), "package.json"),
      rewritten,
    );
  }

  return { deploymentManifest, warnings };
}

async function copyLocalDependency(local: DeployLocalDependency, dest: string): Promise<void> {
  await copyPackageDir(local.sourcePath, dest, local.manifest);
}

export { deploymentSubPath };
