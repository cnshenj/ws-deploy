#!/usr/bin/env node
/** ws-pack command-line interface. */

import * as path from "node:path";

import { Command, InvalidArgumentError, Option } from "commander";

import { runWsPack } from "./pack.js";
import type { ArchiveFormat, InstallMode, PackOptions } from "./types.js";

interface CliOptions {
  target: string;
  repo?: string;
  staging?: string;
  install: InstallMode;
  archive: ArchiveFormat;
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

function parseArchiveFormat(value: string): ArchiveFormat {
  if (value === "none" || value === "tgz" || value === "zip") {
    return value;
  }
  throw new InvalidArgumentError("Expected none, tgz, or zip.");
}

async function run(cli: CliOptions): Promise<void> {
  const repoRoot = path.resolve(cli.repo ?? process.cwd());
  const stagingDir = path.resolve(
    cli.staging ?? path.join(process.cwd(), "ws-pack-out", cli.target),
  );

  const options: PackOptions = {
    repoRoot,
    targetWorkspace: cli.target,
    stagingDir,
    installMode: cli.install,
    includeDevDependencies: cli.includeDev,
    includeOptionalDependencies: cli.includeOptional,
    archive: cli.archive,
    localDepsDir: cli.localDepsDir,
    keepExistingStaging: cli.keepStaging,
  };

  const result = await runWsPack(options);

  process.stdout.write(`\nStaging ready: ${result.stagingDir}\n`);
  process.stdout.write(
    `  local deps: ${result.closure.localDependencies.size}, ` +
      `registry packages: ${result.closure.registryPackages.size}\n`,
  );
  if (result.archivePath) {
    process.stdout.write(`  archive: ${result.archivePath}\n`);
  }
  for (const warning of result.warnings) {
    process.stderr.write(`  warning: ${warning}\n`);
  }
}

const program = new Command();

program
  .name("ws-pack")
  .description("Create a self-contained deployment folder for an npm workspace")
  .requiredOption("-t, --target <name>", "Target workspace package name")
  .option("-r, --repo <dir>", "Monorepo root (default: cwd)")
  .option("-o, --staging <dir>", "Staging output directory (default: ./ws-pack-out/<target>)")
  .addOption(
    new Option("-m, --install <mode>", "Install mode")
      .argParser(parseInstallMode)
      .default("npm-install" as InstallMode),
  )
  .addOption(
    new Option("--archive <format>", "Archive format")
      .argParser(parseArchiveFormat)
      .default("none" as ArchiveFormat),
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
  process.stderr.write(`ws-pack: ${message}\n`);
  process.exitCode = 1;
});
