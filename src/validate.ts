/** Validation of the deployment folder (SPEC Step 9). */

import * as path from "node:path";

import type { RuntimeClosure } from "./types.js";
import { pathExists } from "./util/fsx.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate the deployment tree before it is used.
 *
 * Checks that the deployment root manifest exists, that every local dependency was
 * materialized, and (when installed) that direct runtime dependencies are
 * present in `node_modules`.
 */
export async function validateDeployment(
  deployDir: string,
  closure: RuntimeClosure,
  options: { installed: boolean },
): Promise<ValidationResult> {
  const errors: string[] = [];
  const root = path.resolve(deployDir);

  if (!(await pathExists(path.join(root, "package.json")))) {
    errors.push("Deployment root package.json is missing.");
  }

  // Every local dependency must have been copied.
  for (const local of closure.localDependencies.values()) {
    const dir = path.join(root, ...local.deployRelativePath.split("/"));
    if (!(await pathExists(path.join(dir, "package.json")))) {
      errors.push(
        `Local dependency "${local.name}" was not materialized at ${local.deployRelativePath}.`,
      );
    }
  }

  if (options.installed) {
    // Direct runtime local deps should resolve inside node_modules.
    for (const local of closure.localDependencies.values()) {
      const linkPath = path.join(root, "node_modules", ...local.name.split("/"));
      if (!(await pathExists(linkPath))) {
        errors.push(
          `Local dependency "${local.name}" is not present under node_modules after install.`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
