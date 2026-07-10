/** Materializes the deployment tree: copy files + rewrite manifests (SPEC §7.5 / FR3-5, Step 7). */

import * as path from "node:path";

import type { PackageJson, DeployOptions, RuntimeClosure, DeployLocalDependency } from "./types.js";
import { copyPackageDir, isDirectory, removeDir, writeJson } from "./util/fsx.js";

export interface MaterializeResult {
  /** The rewritten deployment root manifest. */
  rootManifest: PackageJson;
  warnings: string[];
}

const WORKSPACE_OR_FILE = /^(workspace:|file:|link:)/;

/** Normalize a package name into its filesystem sub-path (keeps scopes). */
function deploySubPath(name: string): string {
  return name;
}

/** Compute a `file:` reference from `manifestRelDir` to a local package's deployment directory. */
function computeLocalReference(manifestRelDir: string, depDeployRelativePath: string): string {
  const rel = path.relative(manifestRelDir || ".", depDeployRelativePath).replace(/\\/g, "/");
  const normalized = rel.startsWith(".") ? rel : `./${rel}`;
  return `file:${normalized}`;
}

/** Rewrite a manifest so local deps point at deployment-local `file:` paths. */
function rewriteManifest(
  manifest: PackageJson,
  manifestRelDir: string,
  closure: RuntimeClosure,
  options: { includeDev: boolean; isRoot: boolean },
  warnings: string[],
): PackageJson {
  const rewritten: PackageJson = { ...manifest };

  // Deployment root must not be a workspace root itself.
  delete rewritten.workspaces;

  for (const section of ["dependencies", "optionalDependencies"] as const) {
    const original = manifest[section];
    if (!original) {
      continue;
    }
    const next: Record<string, string> = {};
    for (const [name, spec] of Object.entries(original)) {
      const local = closure.localDependencies.get(name);
      if (local) {
        next[name] = computeLocalReference(manifestRelDir, local.deployRelativePath);
      } else if (spec === undefined) {
        continue;
      } else if (WORKSPACE_OR_FILE.test(spec)) {
        warnings.push(
          `Dropped unresolved ${section} entry "${name}": "${spec}" ` +
            `in ${manifestRelDir || "<root>"} (not part of the runtime closure).`,
        );
      } else {
        next[name] = spec; // registry dependency, left untouched
      }
    }
    rewritten[section] = next;
  }

  // devDependencies are prod-irrelevant in the deployment.
  if (!(options.isRoot && options.includeDev)) {
    delete rewritten.devDependencies;
  }

  return rewritten;
}

/**
 * Materialize the deployment tree for a closure.
 *
 * 1. (Re)create the deployment directory.
 * 2. Copy the target workspace files into the deployment root.
 * 3. Copy each local dependency into `local-packages/<name>`.
 * 4. Rewrite the root manifest and every local manifest so workspace/file
 *    specifiers point at deployment-local `file:` references.
 */
export async function materialize(
  closure: RuntimeClosure,
  options: Pick<DeployOptions, "deployDir" | "includeDevDependencies" | "keepExistingDeployDir">,
): Promise<MaterializeResult> {
  const deployDir = path.resolve(options.deployDir);
  const warnings: string[] = [];

  if (!options.keepExistingDeployDir && (await isDirectory(deployDir))) {
    await removeDir(deployDir);
  }

  // Copy the target workspace into the deployment root.
  await copyPackageDir(closure.target.path, deployDir, closure.target.manifest);

  // Copy each local dependency.
  for (const local of closure.localDependencies.values()) {
    const dest = path.join(deployDir, ...local.deployRelativePath.split("/"));
    await copyLocalDependency(local, dest);
  }

  // Rewrite the root manifest.
  const rootManifest = rewriteManifest(
    closure.target.manifest,
    "",
    closure,
    { includeDev: options.includeDevDependencies ?? false, isRoot: true },
    warnings,
  );
  await writeJson(path.join(deployDir, "package.json"), rootManifest);

  // Rewrite each local dependency manifest.
  for (const local of closure.localDependencies.values()) {
    const manifestRelDir = local.deployRelativePath;
    const rewritten = rewriteManifest(
      local.manifest,
      manifestRelDir,
      closure,
      { includeDev: false, isRoot: false },
      warnings,
    );
    await writeJson(path.join(deployDir, ...manifestRelDir.split("/"), "package.json"), rewritten);
  }

  return { rootManifest, warnings };
}

async function copyLocalDependency(local: DeployLocalDependency, dest: string): Promise<void> {
  await copyPackageDir(local.sourcePath, dest, local.manifest);
}

export { deploySubPath };
