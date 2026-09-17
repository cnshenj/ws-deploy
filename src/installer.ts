/** Installer adapter (SPEC §7.6 / Step 8). npm-only, pluggable seam for future PMs. */

import { execa } from "execa";

import type { DeployOptions, InstallMode } from "./types.js";

type InstallPolicies = Pick<
  DeployOptions,
  "includeDevDependencies" | "includeOptionalDependencies"
>;

/** A pluggable package-manager backend. */
export interface InstallerAdapter {
  readonly name: string;
  install(
    deploymentDir: string,
    mode: InstallMode,
    npmrc?: string,
    policies?: InstallPolicies,
  ): Promise<void>;
}

/** npm CLI arguments per install mode. */
const NPM_ARGS: Record<Exclude<InstallMode, "none">, string[]> = {
  "npm-ci": ["ci", "--install-links", "--ignore-scripts"],
  "npm-install": ["install", "--install-links", "--ignore-scripts", "--no-audit", "--no-fund"],
};

/** npm-backed installer. */
export class NpmInstaller implements InstallerAdapter {
  readonly name = "npm";

  async install(
    deploymentDir: string,
    mode: InstallMode,
    npmrc?: string,
    policies?: InstallPolicies,
  ): Promise<void> {
    if (mode === "none") {
      return;
    }
    // execa resolves `npm`/`npm.cmd` across platforms without a shell, and
    // throws a descriptive error on a non-zero exit code.
    const args = [...NPM_ARGS[mode]];
    if (npmrc) {
      args.push("--userconfig", npmrc);
    }
    if (policies) {
      args.push(policies.includeDevDependencies ? "--include=dev" : "--omit=dev");
      args.push(policies.includeOptionalDependencies ? "--include=optional" : "--omit=optional");
    }
    await execa("npm", args, { cwd: deploymentDir, stdio: "inherit" });
  }
}

/** Return the installer for an install mode (npm only for now). */
export function getInstaller(): InstallerAdapter {
  return new NpmInstaller();
}
