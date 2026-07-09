/** Installer adapter (SPEC §7.6 / Step 8). npm-only, pluggable seam for future PMs. */

import { spawn } from "node:child_process";

import type { InstallMode } from "./types.js";

/** A pluggable package-manager backend. */
export interface InstallerAdapter {
  readonly name: string;
  install(stagingDir: string, mode: InstallMode): Promise<void>;
}

/**
 * Run a shell command line, inheriting stdio, resolving on exit code 0.
 *
 * `shell: true` is used (required to launch `npm`/`npm.cmd` on Windows). The
 * command line is composed only from fixed literals, so there is no argument
 * injection surface; passing a single string avoids the DEP0190 warning that
 * fires when an args array is combined with `shell: true`.
 */
function run(commandLine: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandLine, { cwd, stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`\`${commandLine}\` failed with exit code ${code}.`));
      }
    });
  });
}

/** npm-backed installer. */
export class NpmInstaller implements InstallerAdapter {
  readonly name = "npm";

  async install(stagingDir: string, mode: InstallMode): Promise<void> {
    if (mode === "none") {
      return;
    }
    const commandLine =
      mode === "npm-ci"
        ? "npm ci --ignore-scripts"
        : "npm install --ignore-scripts --no-audit --no-fund";
    await run(commandLine, stagingDir);
  }
}

/** Return the installer for an install mode (npm only for now). */
export function getInstaller(): InstallerAdapter {
  return new NpmInstaller();
}
