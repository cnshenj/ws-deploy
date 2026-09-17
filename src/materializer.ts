/** Materializes the deployment tree: copy target files, optionally stage locals, rewrite manifests. */

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

/** Compute a portable `file:` reference between two absolute package directories. */
function computeLocalReference(manifestDir: string, dependencyDir: string): string {
  const rel = path.relative(manifestDir, dependencyDir).replace(/\\/g, "/");
  const normalized = rel.startsWith(".") ? rel : `./${rel}`;
  return `file:${normalized}`;
}

/** Rewrite a manifest so local deps point at source or deployment-local `file:` paths. */
function rewriteManifest(
  manifest: PackageJson,
  manifestDir: string,
  manifestLabel: string,
  closure: RuntimeClosure,
  options: {
    includeDev: boolean;
    isDeploymentManifest: boolean;
    localPackageDir: (local: DeployLocalDependency) => string;
  },
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
        next[name] = computeLocalReference(manifestDir, options.localPackageDir(local));
      } else if (spec === undefined) {
        continue;
      } else if (WORKSPACE_OR_FILE.test(spec)) {
        warnings.push(
          `Dropped unresolved ${section} entry "${name}": "${spec}" ` +
            `in ${manifestLabel} (not part of the runtime closure).`,
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
 * 3. Optionally copy each local dependency into `local-packages/<name>`.
 * 4. Rewrite local references in the deployment manifest and, in copy mode,
 *    in every staged local manifest.
 */
export async function materialize(
  closure: RuntimeClosure,
  repositoryManifest: PackageJson,
  options: Pick<
    DeployOptions,
    "deploymentDir" | "includeDevDependencies" | "copyLocalPackages" | "keepExistingDeploymentDir"
  >,
): Promise<MaterializeResult> {
  const deploymentDir = path.resolve(options.deploymentDir);
  const copyLocalPackages = options.copyLocalPackages ?? false;
  const warnings: string[] = [];

  if (!options.keepExistingDeploymentDir && (await isDirectory(deploymentDir))) {
    await removeDir(deploymentDir);
  }

  // Copy the target workspace into the deployment directory.
  await copyPackageDir(closure.target.path, deploymentDir, closure.target.manifest);

  if (copyLocalPackages) {
    for (const local of closure.localDependencies.values()) {
      const dest = path.join(deploymentDir, ...local.deploymentRelativePath.split("/"));
      await copyLocalDependency(local, dest);
    }
  }

  const localPackageDir = (local: DeployLocalDependency): string =>
    copyLocalPackages
      ? path.join(deploymentDir, ...local.deploymentRelativePath.split("/"))
      : local.sourcePath;

  // Rewrite the deployment manifest.
  const deploymentManifest = rewriteManifest(
    closure.target.manifest,
    deploymentDir,
    "<deployment>",
    closure,
    {
      includeDev: options.includeDevDependencies ?? false,
      isDeploymentManifest: true,
      localPackageDir,
    },
    warnings,
  );
  const repositoryOverrides = repositoryManifest["overrides"];
  if (repositoryOverrides === undefined) {
    delete deploymentManifest["overrides"];
  } else {
    deploymentManifest["overrides"] = repositoryOverrides;
  }
  await writeJson(path.join(deploymentDir, "package.json"), deploymentManifest);

  if (copyLocalPackages) {
    for (const local of closure.localDependencies.values()) {
      const manifestDir = localPackageDir(local);
      const rewritten = rewriteManifest(
        local.manifest,
        manifestDir,
        local.deploymentRelativePath,
        closure,
        { includeDev: false, isDeploymentManifest: false, localPackageDir },
        warnings,
      );
      await writeJson(path.join(manifestDir, "package.json"), rewritten);
    }
  }

  return { deploymentManifest, warnings };
}

async function copyLocalDependency(local: DeployLocalDependency, dest: string): Promise<void> {
  await copyPackageDir(local.sourcePath, dest, local.manifest);
}

export { deploymentSubPath };
