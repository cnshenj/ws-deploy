#!/usr/bin/env node
/** ws-deploy command-line interface. */

import * as path from "node:path";

import { Command, InvalidArgumentError, Option } from "commander";

import { runWsDeploy } from "./deploy.js";
import { DEFAULT_INSTALL_MODE, type InstallMode, type DeployOptions } from "./types.js";

interface CliOptions {
  target: string;
  repositoryDir?: string;
  deploymentDir?: string;
  install: InstallMode;
  npmrc?: string;
  includeDev: boolean;
  includeOptional: boolean;
  keepDeploymentDir: boolean;
}

function parseInstallMode(value: string): InstallMode {
  if (value === "npm-install" || value === "npm-ci" || value === "none") {
    return value;
  }
  throw new InvalidArgumentError("Expected npm-install, npm-ci, or none.");
}

async function run(cli: CliOptions): Promise<void> {
  const repositoryDir = path.resolve(cli.repositoryDir ?? process.cwd());
  const deploymentDir = path.resolve(
    cli.deploymentDir ?? path.join(process.cwd(), "deploy", cli.target),
  );

  const options: DeployOptions = {
    repositoryDir,
    targetWorkspace: cli.target,
    deploymentDir,
    installMode: cli.install,
    npmrc: cli.npmrc === undefined ? undefined : path.resolve(cli.npmrc),
    includeDevDependencies: cli.includeDev,
    includeOptionalDependencies: cli.includeOptional,
    keepExistingDeploymentDir: cli.keepDeploymentDir,
  };

  const result = await runWsDeploy(options);

  process.stdout.write(`\nDeployment ready: ${result.deploymentDir}\n`);
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
  .option("-r, --repository-dir <dir>", "Monorepo directory (default: cwd)")
  .option("-o, --deployment-dir <dir>", "Deployment directory (default: ./deploy/<target>)")
  .addOption(
    new Option("-m, --install <mode>", "Install mode")
      .argParser(parseInstallMode)
      .default(DEFAULT_INSTALL_MODE),
  )
  .option("--npmrc <path>", "Path to the .npmrc used for installation")
  .option("--include-dev", "Include the target's devDependencies", false)
  .option("--include-optional", "Include optionalDependencies in the closure", false)
  .option("--keep-deployment-dir", "Do not delete an existing deployment directory first", false)
  .allowExcessArguments(false)
  .action(async (cli: CliOptions) => {
    await run(cli);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ws-deploy: ${message}\n`);
  process.exitCode = 1;
});
