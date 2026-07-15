# ws-deploy

Create a self-contained deployment folder for one workspace package in a multi-workspace npm
monorepo.

`ws-deploy` computes the target package's runtime dependency closure, copies local workspace and
`file:` dependencies, projects the root lockfile into a minimal deployment lockfile, and installs the
result as a standalone package root. Unrelated workspaces and their dependency branches are left
out.

## Requirements

- Node.js 24 or later
- An npm monorepo containing multiple workspaces
- A root `package-lock.json` or `npm-shrinkwrap.json` with a `packages` map (lockfile version 2 or
  later)
- Runtime build output already present when a package publishes built files such as `dist/`

The root lockfile is the source of truth. If a required runtime dependency is missing from it, run
`npm install` at the repository root to refresh the lockfile before using `ws-deploy`.

## Installation

Install the package as a development dependency in the workspace root:

```sh
npm install --save-dev ws-deploy
```

You can then run it with `npx` or from an npm script.

## Quick start

Deploy the workspace whose `package.json` name is `@acme/api`:

```sh
npx ws-deploy --target @acme/api
```

By default, this creates `./deploy/@acme/api` and runs `npm ci` there. The resulting folder is the
deployment root: the target package's rewritten `package.json` is at its top level rather than
under its original workspace path.

A typical CI invocation uses an explicit output path:

```sh
npx ws-deploy \
  --repo . \
  --target @acme/api \
  --deploy-dir ./artifacts/api
```

The deployment folder can then be passed to a container build, hosting platform, or separate
archiving tool.

## Why `ws-deploy`

`ws-deploy` works much like [`pnpm deploy`](https://pnpm.io/cli/deploy), but for npm: both turn one
workspace package into a standalone deployment root, include its local workspace dependencies,
and can produce an isolated `node_modules`. By contrast,
[`turbo prune`](https://turborepo.dev/docs/reference/prune) creates a partial monorepo intended for
subsequent install and build steps.

|                               | `ws-deploy`                                                    | `pnpm deploy`                                         | `turbo prune`                                               |
| ----------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| Primary output                | Standalone npm package root                                    | Standalone pnpm package root                          | Partial monorepo for building the target                    |
| Lockfile                      | New, projected `package-lock.json`                             | Dedicated lockfile projected from the shared lockfile | Pruned copy of the repository lockfile                      |
| Dependency installation       | Configurable: `npm ci`, `npm install`, or none                 | Installed into an isolated `node_modules`             | Not installed                                               |
| Repository layout retained    | No (intentional)                                               | No (intentional)                                      | Yes                                                         |
| Local packages                | Packed locally and rewritten to deployment-local `file:` paths | Installed as internal dependencies                    | Retained as packages in the partial workspace               |
| Package-manager prerequisites | npm workspaces and a root npm lockfile                         | A pnpm workspace; current defaults require injection  | A Turborepo monorepo                                        |
| Best fit                      | Deploying one npm workspace directly                           | Deploying one package from a pnpm workspace           | Creating a smaller build context before install/build steps |

### Benefits

- **`pnpm deploy`-style output for npm.** Get a standalone package without migrating to pnpm or
  adding Turborepo.
- **Reproducible npm installs.** A projected `package-lock.json` preserves exact versions and
  supports `npm ci`, including recursively packed workspace, `file:`, and `link:` dependencies.
- **Flexible materialization.** Choose `npm ci`, `npm install`, or `--install none`, and use the same
  workflow through the typed programmatic API.

## CLI reference

```text
ws-deploy --target <workspace-name> [options]
```

| Option                   | Description                                                          | Default             |
| ------------------------ | -------------------------------------------------------------------- | ------------------- |
| `-t, --target <name>`    | Target workspace package name. Required.                             |                     |
| `-r, --repo <dir>`       | Monorepo root.                                                       | Current directory   |
| `-o, --deploy-dir <dir>` | Deployment output directory.                                         | `./deploy/<target>` |
| `-m, --install <mode>`   | Installation strategy: `npm-ci`, `npm-install`, or `none`.           | `npm-ci`            |
| `--npmrc <path>`         | npm configuration file used by the installation step.                | User npm config     |
| `--include-dev`          | Include the target workspace's `devDependencies`.                    | `false`             |
| `--include-optional`     | Include optional dependencies throughout the closure.                | `false`             |
| `--keep-deploy-dir`      | Keep the existing deployment directory instead of deleting it first. | `false`             |
| `-h, --help`             | Show command help.                                                   |                     |

The target is a package name from a workspace `package.json`, not a filesystem path.

## Install modes

### `npm-ci`

The default and recommended mode for CI/CD. It runs:

```sh
npm ci --ignore-scripts
```

`npm ci` requires the projected manifest and lockfile to agree and recreates `node_modules` from
that lockfile.

### `npm-install`

Runs:

```sh
npm install --ignore-scripts --no-audit --no-fund
```

This mode is useful for local workflows that need npm's more permissive install behavior.

### `none`

Skips npm entirely. The package files, rewritten manifests, local dependencies, and filtered
lockfile are still produced, but `node_modules` is not created. Use this mode to inspect the
projection or install it in a later build stage:

```sh
npx ws-deploy --target @acme/api --install none
```

Both npm-backed modes disable lifecycle scripts. Packages that require `preinstall`, `install`, or
`postinstall` scripts must be prepared before deployment or handled explicitly by the consuming
pipeline.

Use `--npmrc <path>` to run either npm-backed mode with a specific npm configuration file. Relative
paths are resolved from the current working directory. The file is passed to npm as its user config
and is not copied into the deployment folder.

## What gets included

By default, the dependency closure contains:

- The target workspace's `dependencies`
- Transitive registry dependencies at the exact versions in the root lockfile
- Reachable workspace dependencies
- Reachable `file:` and `link:` dependencies
- Resolved peer dependencies required by retained registry packages

Dependency policies are applied as follows:

- `--include-dev` adds the target workspace's `devDependencies` and their reachable runtime
  dependencies. The target's development dependencies remain in the deployment root manifest;
  development dependencies of copied local packages are not included.
- `--include-optional` traverses `optionalDependencies` throughout the closure. Missing optional
  registry packages are omitted with a warning.
- Peers declared by the target or copied local packages are not separate runtime edges. Resolved
  peers of retained registry packages are included at the exact versions and placements from the
  root lockfile because `npm ci` requires a complete install graph. Missing optional peers are
  omitted.
- Unrelated workspaces and dependency branches are always excluded.

Package files are selected with npm's pack-list rules. This respects the package's `files` field,
`.npmignore` or `.gitignore`, and npm's always-included files while excluding `node_modules`.
Build the target and its local dependencies first if their runtime output is generated.

## Output layout

For a target that depends on a local package named `@acme/lib`, the default output resembles:

```text
deploy/@acme/api/
|-- package.json
|-- package-lock.json
|-- node_modules/                 # omitted with --install none
|-- local-packages/
|   `-- @acme/
|       `-- lib/
|           `-- package.json
`-- ...target package files
```

Workspace protocols and local path references are rewritten to deployment-local `file:` references.
For example, `workspace:*` becomes `file:./local-packages/@acme/lib` in the root manifest. Registry
packages remain registry dependencies, with their exact `version`, `resolved`, and `integrity`
metadata copied from the root lockfile where available.

The generated lockfile may place shared versions at the deployment root and conflicting versions
under their consumers. Placement is recalculated for the target's dependency closure rather than
copied from the monorepo's `node_modules` layout.

## Programmatic API

The package also exports `runWsDeploy` and its TypeScript types:

```ts
import * as path from "node:path";

import { runWsDeploy } from "ws-deploy";

const result = await runWsDeploy({
  repoRoot: process.cwd(),
  targetWorkspace: "@acme/api",
  deployDir: path.resolve("artifacts/api"),
  // installMode defaults to "npm-ci"
});

console.log(result.deployDir);
console.log(result.warnings);
```

Unlike the CLI, the programmatic API requires `repoRoot`, `targetWorkspace`, and `deployDir`.
Optional settings are:

```ts
interface DeployOptions {
  repoRoot: string;
  targetWorkspace: string;
  deployDir: string;
  installMode?: "npm-ci" | "npm-install" | "none";
  npmrc?: string;
  includeDevDependencies?: boolean;
  includeOptionalDependencies?: boolean;
  keepExistingDeployDir?: boolean;
}
```

The resolved closure and projected lockfile are returned for tooling that needs to inspect the
result.

## Current scope

- npm is the only package-manager backend currently implemented.
- Packaging the deployment folder into `.zip` or `.tgz` is intentionally out of scope.
- Peer dependency compatibility is not revalidated.
- A `file:` dependency outside the repository is allowed, but it can reduce reproducibility.

## Contributors

The detailed behavioral contract and architecture are documented in [SPEC.md](SPEC.md).

Install dependencies and run the checks from the repository root:

```sh
npm ci
npm run build
npm test
npm run lint
npm run format:check
```

Use `npm run format` to apply the configured formatting rules. To run the CLI directly from source
during development:

```sh
npm run ws-deploy -- --target <workspace-name> --install none
```

The main implementation stages live under `src/`: workspace discovery, closure traversal,
materialization, lockfile projection, installation, and validation. Tests under `tests/` construct
temporary fixture repositories and must clean up all owned files and directories.
