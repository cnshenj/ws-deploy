/** Installer adapter (SPEC §7.6 / Step 8). npm-only, pluggable seam for future PMs. */

import { execa } from "execa";

import type { InstallMode } from "./types.js";

/** A pluggable package-manager backend. */
export interface InstallerAdapter {
  readonly name: string;
  install(deployDir: string, mode: InstallMode): Promise<void>;
}

/** npm CLI arguments per install mode. */
const NPM_ARGS: Record<Exclude<InstallMode, "none">, string[]> = {
  "npm-ci": ["ci", "--ignore-scripts"],
  "npm-install": ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
};

/** npm-backed installer. */
export class NpmInstaller implements InstallerAdapter {
  readonly name = "npm";

  async install(deployDir: string, mode: InstallMode): Promise<void> {
    if (mode === "none") {
      return;
    }
    // execa resolves `npm`/`npm.cmd` across platforms without a shell, and
    // throws a descriptive error on a non-zero exit code.
    await execa("npm", NPM_ARGS[mode], { cwd: deployDir, stdio: "inherit" });
  }
}

/** Return the installer for an install mode (npm only for now). */
export function getInstaller(): InstallerAdapter {
  return new NpmInstaller();
}
