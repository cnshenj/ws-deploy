#!/usr/bin/env node
/** ws-deploy command-line interface. */

import * as path from "node:path";

import { Command, InvalidArgumentError, Option } from "commander";

import { runWsDeploy } from "./deploy.js";
import type { InstallMode, DeployOptions } from "./types.js";

interface CliOptions {
  target: string;
  repo?: string;
  staging?: string;
  install: InstallMode;
  includeDev: boolean;
  includeOptional: boolean;
  localDepsDir?: string;
  keepStaging: boolean;
}

function parseInstallMode(value: string): InstallMode {
  if (value === "npm-install" || value === "npm-ci" || value === "none") {
    return value;
  }
  throw new InvalidArgumentError("Expected npm-install, npm-ci, or none.");
}

async function run(cli: CliOptions): Promise<void> {
  const repoRoot = path.resolve(cli.repo ?? process.cwd());
  const stagingDir = path.resolve(
    cli.staging ?? path.join(process.cwd(), "ws-deploy-out", cli.target),
  );

  const options: DeployOptions = {
    repoRoot,
    targetWorkspace: cli.target,
    stagingDir,
    installMode: cli.install,
    includeDevDependencies: cli.includeDev,
    includeOptionalDependencies: cli.includeOptional,
    localDepsDir: cli.localDepsDir,
    keepExistingStaging: cli.keepStaging,
  };

  const result = await runWsDeploy(options);

  process.stdout.write(`\nStaging ready: ${result.stagingDir}\n`);
  process.stdout.write(
    `  local deps: ${result.closure.localDependencies.size}, ` +
      `registry packages: ${result.closure.registryPackages.size}\n`,
  );
  for (const warning of result.warnings) {
    process.stderr.write(`  warning: ${warning}\n`);
  }
}

const program = new Command();

program
  .name("ws-deploy")
  .description("Create a self-contained deployment folder for an npm workspace")
  .requiredOption("-t, --target <name>", "Target workspace package name")
  .option("-r, --repo <dir>", "Monorepo root (default: cwd)")
  .option("-o, --staging <dir>", "Staging output directory (default: ./ws-deploy-out/<target>)")
  .addOption(
    new Option("-m, --install <mode>", "Install mode")
      .argParser(parseInstallMode)
      .default("npm-install" as InstallMode),
  )
  .option("--include-dev", "Include the target's devDependencies", false)
  .option("--include-optional", "Include optionalDependencies in the closure", false)
  .option("--local-deps-dir <dir>", "Directory (relative to staging) for local deps")
  .option("--keep-staging", "Do not delete an existing staging directory first", false)
  .allowExcessArguments(false)
  .action(async (cli: CliOptions) => {
    await run(cli);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ws-deploy: ${message}\n`);
  process.exitCode = 1;
});
