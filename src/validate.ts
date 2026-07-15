/** Validation of the deployment folder (SPEC Step 9). */

import * as path from "node:path";

import type { RuntimeClosure } from "./types.js";
import { pathExists } from "./filesystem.js";

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
  options: { installed: boolean },
): Promise<ValidationResult> {
  const errors: string[] = [];
  const resolvedDeploymentDir = path.resolve(deploymentDir);

  if (!(await pathExists(path.join(resolvedDeploymentDir, "package.json")))) {
    errors.push("Deployment package.json is missing.");
  }

  // Every local dependency must have been copied.
  for (const local of closure.localDependencies.values()) {
    const dir = path.join(resolvedDeploymentDir, ...local.deploymentRelativePath.split("/"));
    if (!(await pathExists(path.join(dir, "package.json")))) {
      errors.push(
        `Local dependency "${local.name}" was not materialized at ${local.deploymentRelativePath}.`,
      );
    }
  }

  if (options.installed) {
    // Direct runtime local deps should resolve inside node_modules.
    for (const local of closure.localDependencies.values()) {
      const linkPath = path.join(resolvedDeploymentDir, "node_modules", ...local.name.split("/"));
      if (!(await pathExists(linkPath))) {
        errors.push(
          `Local dependency "${local.name}" is not present under node_modules after install.`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
