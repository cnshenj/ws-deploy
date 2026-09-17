/** Validation of the deployment folder (SPEC Step 9). */

import * as path from "node:path";

import type { NpmLockfile, RuntimeClosure } from "./types.js";
import { pathExists, readManifest } from "./filesystem.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate the deployment tree before it is used.
 *
 * Checks that the deployment manifest exists, that every local dependency was
 * materialized, and (when installed) that direct runtime dependencies are
 * present in `node_modules`.
 */
export async function validateDeployment(
  deploymentDir: string,
  closure: RuntimeClosure,
  options: { installed: boolean; copyLocalPackages?: boolean; lockfile?: NpmLockfile },
): Promise<ValidationResult> {
  const errors: string[] = [];
  const resolvedDeploymentDir = path.resolve(deploymentDir);

  if (!(await pathExists(path.join(resolvedDeploymentDir, "package.json")))) {
    errors.push("Deployment package.json is missing.");
  }

  if (options.copyLocalPackages) {
    for (const local of closure.localDependencies.values()) {
      const dir = path.join(resolvedDeploymentDir, ...local.deploymentRelativePath.split("/"));
      if (!(await pathExists(path.join(dir, "package.json")))) {
        errors.push(
          `Local dependency "${local.name}" was not materialized at ${local.deploymentRelativePath}.`,
        );
      }
    }
  }

  if (options.installed) {
    // Direct runtime local deps should resolve inside node_modules.
    for (const local of closure.localDependencies.values()) {
      const linkPath = path.join(resolvedDeploymentDir, "node_modules", ...local.name.split("/"));
      if (!local.optional && !(await pathExists(path.join(linkPath, "package.json")))) {
        errors.push(
          `Local dependency "${local.name}" is not present under node_modules after install.`,
        );
      }
    }
    for (const [key, entry] of Object.entries(options.lockfile?.packages ?? {})) {
      if (
        (!key.startsWith("node_modules/") && !key.includes("/node_modules/")) ||
        entry.link ||
        entry.optional
      ) {
        continue;
      }
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      if (closure.localDependencies.has(name) && key === `node_modules/${name}`) {
        continue;
      }
      const manifestPath = path.join(resolvedDeploymentDir, key, "package.json");
      try {
        const manifest = await readManifest(manifestPath);
        if (entry.version !== undefined && manifest.version !== entry.version) {
          errors.push(
            `Registry dependency "${name}" at ${key} has version "${manifest.version}" instead of locked version "${entry.version}".`,
          );
        }
      } catch {
        errors.push(
          `Registry dependency "${name}" is missing or has an invalid package.json at ${key} after install.`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
