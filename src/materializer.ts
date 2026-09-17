/** Materializes the deployment tree: copy target files, optionally stage locals, rewrite manifests. */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import npa from "npm-package-arg";

import type {
  PackageJson,
  DeployOptions,
  RuntimeClosure,
  DeployLocalDependency,
  ClosureRegistryPackage,
} from "./types.js";
import {
  assertSafeDeploymentDirectory,
  copyPackageDir,
  isDirectory,
  removeDir,
  writeJson,
} from "./filesystem.js";

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
export function computeLocalReference(manifestDir: string, dependencyDir: string): string {
  const rel = path.relative(manifestDir, dependencyDir).replace(/\\/g, "/");
  const normalized = path.isAbsolute(rel) || rel.startsWith(".") ? rel : `./${rel}`;
  return `file:${normalized}`;
}

/** Rewrite a manifest so local deps point at source or deployment-local `file:` paths. */
export function rewriteManifest(
  manifest: PackageJson,
  manifestDir: string,
  manifestLabel: string,
  closure: RuntimeClosure,
  options: {
    includeDev: boolean;
    isDeploymentManifest: boolean;
    sourceDir: string;
    localPackageDir: (local: DeployLocalDependency) => string;
    localTarballPath: (tarball: NonNullable<ClosureRegistryPackage["localTarball"]>) => string;
  },
  warnings: string[],
): PackageJson {
  const rewritten: PackageJson = { ...manifest };
  const localTarballs = [...closure.registryPackages.values()].flatMap((node) =>
    node.localTarball ? [node.localTarball] : [],
  );
  const registryNames = new Set([...closure.registryPackages.values()].map((node) => node.name));

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
    if (section === "optionalDependencies" && !closure.includeOptionalDependencies) {
      delete rewritten.optionalDependencies;
      continue;
    }
    const original = manifest[section];
    if (!original) {
      continue;
    }
    const next: Record<string, string> = {};
    for (const [name, spec] of Object.entries(original)) {
      if (
        (section !== "optionalDependencies" &&
          manifest.optionalDependencies?.[name] !== undefined) ||
        (section === "devDependencies" && manifest.dependencies?.[name] !== undefined)
      ) {
        continue;
      }
      const localName = closure.localResolutions
        ? closure.localResolutions.get(options.sourceDir)?.get(name)
        : name;
      const local = localName === undefined ? undefined : closure.localDependencies.get(localName);
      const archive =
        spec !== undefined && !spec.startsWith("workspace:")
          ? localTarballs.find(
              (tarball) =>
                tarball.sourcePath ===
                npa.resolve(name, spec.replace(/^link:/, "file:"), options.sourceDir).fetchSpec,
            )
          : undefined;
      if (section === "optionalDependencies" && !local && !archive && !registryNames.has(name)) {
        continue;
      }
      if (local) {
        next[name] = computeLocalReference(manifestDir, options.localPackageDir(local));
      } else if (spec === undefined) {
        continue;
      } else if (archive) {
        next[name] = computeLocalReference(manifestDir, options.localTarballPath(archive));
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
  > & { sourceDirectories?: string[] },
): Promise<MaterializeResult> {
  const deploymentDir = path.resolve(options.deploymentDir);
  const copyLocalPackages = options.copyLocalPackages ?? false;
  const warnings: string[] = [];

  await assertSafeDeploymentDirectory(deploymentDir, [
    closure.target.path,
    ...[...closure.localDependencies.values()].map((local) => local.sourcePath),
    ...[...closure.registryPackages.values()].flatMap((node) =>
      node.localTarball ? [node.localTarball.sourcePath] : [],
    ),
    ...(options.sourceDirectories ?? []),
  ]);

  if (!options.keepExistingDeploymentDir && (await isDirectory(deploymentDir))) {
    await removeDir(deploymentDir);
  }

  // Copy the target workspace into the deployment directory.
  await copyPackageDir(closure.target.path, deploymentDir, closure.target.manifest);
  await fs.rm(path.join(deploymentDir, "npm-shrinkwrap.json"), { force: true });

  const localTarballPath = (tarball: NonNullable<ClosureRegistryPackage["localTarball"]>): string =>
    copyLocalPackages
      ? path.join(deploymentDir, tarball.deploymentRelativePath)
      : tarball.sourcePath;

  if (copyLocalPackages) {
    for (const node of closure.registryPackages.values()) {
      if (node.localTarball) {
        const destination = localTarballPath(node.localTarball);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(node.localTarball.sourcePath, destination);
      }
    }
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
      sourceDir: closure.target.path,
      localPackageDir,
      localTarballPath,
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
        {
          includeDev: false,
          isDeploymentManifest: false,
          sourceDir: local.sourcePath,
          localPackageDir,
          localTarballPath,
        },
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
