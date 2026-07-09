#!/usr/bin/env node
/** ws-pack command-line interface. */

import * as path from "node:path";
import { parseArgs } from "node:util";

import { runWsPack } from "./pack.js";
import type { ArchiveFormat, InstallMode, PackOptions } from "./types.js";

const USAGE = `ws-pack - create a self-contained deployment folder for an npm workspace

Usage:
  ws-pack --target <workspace> [options]

Options:
  -t, --target <name>        Target workspace package name (required)
  -r, --repo <dir>           Monorepo root (default: cwd)
  -o, --staging <dir>        Staging output directory (default: ./ws-pack-out/<target>)
  -m, --install <mode>       Install mode: npm-install | npm-ci | none (default: npm-install)
      --archive <format>     Archive format: none | tgz | zip (default: none)
      --include-dev          Include the target's devDependencies
      --include-optional     Include optionalDependencies in the closure
      --local-deps-dir <dir> Directory (relative to staging) for local deps (default: _staging_deps)
      --keep-staging         Do not delete an existing staging directory first
  -h, --help                 Show this help
`;

interface CliValues {
  target?: string;
  repo?: string;
  staging?: string;
  install?: string;
  archive?: string;
  "include-dev"?: boolean;
  "include-optional"?: boolean;
  "local-deps-dir"?: string;
  "keep-staging"?: boolean;
  help?: boolean;
}

function parseInstallMode(value: string | undefined): InstallMode {
  if (value === undefined) {
    return "npm-install";
  }
  if (value === "npm-install" || value === "npm-ci" || value === "none") {
    return value;
  }
  throw new Error(`Invalid --install value "${value}". Expected npm-install, npm-ci, or none.`);
}

function parseArchiveFormat(value: string | undefined): ArchiveFormat {
  if (value === undefined) {
    return "none";
  }
  if (value === "none" || value === "tgz" || value === "zip") {
    return value;
  }
  throw new Error(`Invalid --archive value "${value}". Expected none, tgz, or zip.`);
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: "string", short: "t" },
      repo: { type: "string", short: "r" },
      staging: { type: "string", short: "o" },
      install: { type: "string", short: "m" },
      archive: { type: "string" },
      "include-dev": { type: "boolean" },
      "include-optional": { type: "boolean" },
      "local-deps-dir": { type: "string" },
      "keep-staging": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  const cli = values as CliValues;

  if (cli.help || !cli.target) {
    process.stdout.write(USAGE);
    return cli.help ? 0 : 1;
  }

  const repoRoot = path.resolve(cli.repo ?? process.cwd());
  const stagingDir = path.resolve(
    cli.staging ?? path.join(process.cwd(), "ws-pack-out", cli.target),
  );

  const options: PackOptions = {
    repoRoot,
    targetWorkspace: cli.target,
    stagingDir,
    installMode: parseInstallMode(cli.install),
    includeDevDependencies: cli["include-dev"] ?? false,
    includeOptionalDependencies: cli["include-optional"] ?? false,
    archive: parseArchiveFormat(cli.archive),
    localDepsDir: cli["local-deps-dir"],
    keepExistingStaging: cli["keep-staging"] ?? false,
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
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    return undefined;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ws-pack: ${message}\n`);
    process.exitCode = 1;
  },
);
