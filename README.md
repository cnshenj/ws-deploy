# ws-deploy

Create a self-contained deployment folder for one workspace package in a multi-workspace npm
monorepo.

`ws-deploy` computes the target package's runtime dependency closure, projects the repository
lockfile into a minimal deployment lockfile, and installs the result as a standalone package.
Local workspace and `file:` dependencies are packed from their source directories by default;
they can instead be copied into the deployment. Unrelated workspaces and their dependency branches
are left out.

## Requirements

- Node.js 24 or later
- An npm monorepo containing multiple workspaces
- A repository `package-lock.json` or `npm-shrinkwrap.json` with a `packages` map (lockfile version
  2 or later)
- Runtime build output already present when a package publishes built files such as `dist/`

The repository lockfile is the source of truth. If a required runtime dependency is missing from
it, run `npm install` in the repository directory to refresh the lockfile before using `ws-deploy`.
When both lockfiles exist, `npm-shrinkwrap.json` takes precedence, matching npm. Both formats
must have a valid `packages` map and lockfile version 2 or later.

## Installation

Install the package as a development dependency in the repository directory:

```sh
npm install --save-dev ws-deploy
```

You can then run it with `npx` or from an npm script.

## Quick start

Deploy the workspace whose `package.json` name is `@acme/api`:

```sh
npx ws-deploy --target @acme/api
```

By default, this creates `./deploy/@acme/api` and runs `npm ci` there. The target package's rewritten
`package.json` is at the top level of this deployment directory rather than under its original
workspace path.

A typical CI invocation uses an explicit output path:

```sh
npx ws-deploy \
  --repository-dir . \
  --target @acme/api \
  --deployment-dir ./artifacts/api
```

The deployment folder can then be passed to a container build, hosting platform, or separate
archiving tool.

The output directory must not overlap a source workspace or local dependency, including through
symlinks or directory junctions. Paths that could delete or overwrite source packages are rejected
before output files are changed.

## Why `ws-deploy`

`ws-deploy` works much like [`pnpm deploy`](https://pnpm.io/cli/deploy), but for npm: both turn one
workspace package into a standalone deployment directory, include its local workspace dependencies,
and can produce an isolated `node_modules`. By contrast,
[`turbo prune`](https://turborepo.dev/docs/reference/prune) creates a partial monorepo intended for
subsequent install and build steps.

|                               | `ws-deploy`                                                    | `pnpm deploy`                                         | `turbo prune`                                               |
| ----------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| Primary output                | Standalone npm package directory                               | Standalone pnpm package directory                     | Partial monorepo for building the target                    |
| Lockfile                      | New, projected `package-lock.json`                             | Dedicated lockfile projected from the shared lockfile | Pruned copy of the repository lockfile                      |
| Dependency installation       | Configurable: `npm ci`, `npm install`, or none                 | Installed into an isolated `node_modules`             | Not installed                                               |
| Repository layout retained    | No (intentional)                                               | No (intentional)                                      | Yes                                                         |
| Local packages                | Packed from source paths or copied with an option               | Installed as internal dependencies                    | Retained as packages in the partial workspace               |
| Package-manager prerequisites | npm workspaces and a repository lockfile                       | A pnpm workspace; current defaults require injection  | A Turborepo monorepo                                        |
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

| Option                      | Description                                                          | Default             |
| --------------------------- | -------------------------------------------------------------------- | ------------------- |
| `-t, --target <name>`       | Target workspace package name. Required.                             |                     |
| `-r, --repository-dir <dir>` | Monorepo directory.                                                 | Current directory   |
| `-o, --deployment-dir <dir>` | Deployment output directory.                                       | `./deploy/<target>` |
| `-m, --install <mode>`      | Installation strategy: `npm-ci`, `npm-install`, or `none`.           | `npm-ci`            |
| `--npmrc <path>`            | npm configuration file used by the installation step.                | User npm config     |
| `--include-dev`             | Include the target workspace's `devDependencies`.                    | `false`             |
| `--include-optional`        | Include optional dependencies throughout the closure.                | `false`             |
| `--copy-local-packages`     | Copy local packages into the deployment before installation.         | `false`             |
| `--keep-deployment-dir`     | Keep the existing deployment directory instead of deleting it first. | `false`             |
| `-h, --help`                | Show command help.                                                    |                     |

The target is a package name from a workspace `package.json`, not a filesystem path.

## Install modes

### `npm-ci`

The default and recommended mode for CI/CD. It runs:

```sh
npm ci --install-links --ignore-scripts --omit=dev --omit=optional
```

`npm ci` requires the projected manifest and lockfile to agree and recreates `node_modules` from
that lockfile.

### `npm-install`

Runs:

```sh
npm install --install-links --ignore-scripts --no-audit --no-fund --omit=dev --omit=optional
```

This mode is useful for local workflows that need npm's more permissive install behavior.

### `none`

Skips npm entirely. The package files and filtered lockfile are still produced, but `node_modules`
is not created. Without `--copy-local-packages`, local references point back to source directories
and must remain valid when npm is run later. Use this mode to inspect the projection or install it
in a later build stage:

```sh
npx ws-deploy --target @acme/api --install none
```

Both npm-backed modes disable lifecycle scripts. Packages that require `preinstall`, `install`, or
`postinstall` scripts must be prepared before deployment or handled explicitly by the consuming
pipeline.

`--include-dev` and `--include-optional` replace the corresponding omission flag with an explicit
npm inclusion flag, including when `NODE_ENV=production` or npm configuration would omit them.

Use `--npmrc <path>` to run either npm-backed mode with a specific npm configuration file. Relative
paths are resolved from the current working directory. The file is passed to npm as its user config
and is not copied into the deployment folder.

## What gets included

By default, the dependency closure contains:

- The target workspace's `dependencies`
- Transitive registry dependencies at the exact versions in the repository lockfile
- Reachable workspace dependencies
- Reachable `file:` and `link:` dependencies
- Local tarball dependencies, including renamed dependency slots
- Required peers of the target and local packages, and resolved peers of retained registry packages

Dependency policies are applied as follows:

- `--include-dev` adds the target workspace's `devDependencies` and their reachable runtime
  dependencies. The target's development dependencies remain in the deployment manifest;
  development dependencies of copied local packages are not included.
- `--include-optional` traverses `optionalDependencies` throughout the closure. Missing optional
  registry packages and local sources are omitted with a warning. Optional declarations override
  same-name regular and development declarations. npm evaluates platform restrictions during
  installation, and legitimately omitted optional packages do not fail deployment validation.
- Peers are install-graph edges because modern npm requires them for `npm ci`. Required peers of
  the target and local packages are retained; their optional peers are not auto-added. Resolved
  registry-package peers retain their locked resolutions, and missing optional peers are omitted.
- Unrelated workspaces and dependency branches are always excluded.

Workspace name matching is only a classification hint: the lockfile decides whether a version
request resolves to the workspace or a registry version. Explicit npm aliases, Git specs, and
remote tarballs stay external even when their dependency name matches a workspace.

Package files are selected with npm's pack-list rules. This respects the package's `files` field,
`.npmignore` or `.gitignore`, and npm's always-included files while excluding `node_modules`.
Build the target and its local dependencies first if their runtime output is generated.

## Output layout

For a target that depends on a local package named `@acme/lib`, the default installed output
resembles:

```text
deploy/@acme/api/
|-- package.json
|-- package-lock.json
|-- node_modules/                 # omitted with --install none
|   `-- @acme/
|       `-- lib/                  # physical package installed with --install-links
`-- ...target package files
```

Workspace protocols and local path references are rewritten to `file:` references relative to the
deployment directory. npm packs those source directories into `node_modules` because
`--install-links` is always used. With `--copy-local-packages`, local packages are first copied to
`local-packages/<name>` and references point there instead. Copy mode also rewrites manifests inside
local packages, so use it when nested local packages contain `workspace:` dependencies or when the
uninstalled deployment must not depend on source paths. Registry packages remain registry
dependencies, with their exact `version`, `resolved`, and `integrity` metadata copied from the
repository lockfile where available.

Local `.tgz` dependencies retain their locked integrity. Their paths are rebased by default;
copy mode stages the archives under `local-tarballs/`. Local package lock entries retain dependency,
peer, binary, and platform metadata so recursive installations remain complete. A copied target
shrinkwrap is removed from the output so it cannot override the projected deployment lockfile.

The generated lockfile may place shared versions in the deployment's top-level `node_modules` and
conflicting versions under their consumers. Placement is recalculated for the target's dependency
closure rather than copied from the monorepo's `node_modules` layout.
Equal names and versions are deduplicated only when their lock metadata and resolved dependency
graphs agree. Different tarballs or transitive resolutions remain separate instances. Local
workspace install slots are reserved, so conflicting transitive registry versions nest beneath
their consumers instead of replacing the workspace.

## Programmatic API

The package also exports `runWsDeploy` and its TypeScript types:

```ts
import * as path from "node:path";

import { runWsDeploy } from "ws-deploy";

const result = await runWsDeploy({
  repositoryDir: process.cwd(),
  targetWorkspace: "@acme/api",
  deploymentDir: path.resolve("artifacts/api"),
  // installMode defaults to "npm-ci"
});

console.log(result.deploymentDir);
console.log(result.warnings);
```

Unlike the CLI, the programmatic API requires `repositoryDir`, `targetWorkspace`, and
`deploymentDir`.
Optional settings are:

```ts
interface DeployOptions {
  repositoryDir: string;
  targetWorkspace: string;
  deploymentDir: string;
  installMode?: "npm-ci" | "npm-install" | "none";
  npmrc?: string;
  includeDevDependencies?: boolean;
  includeOptionalDependencies?: boolean;
  copyLocalPackages?: boolean;
  keepExistingDeploymentDir?: boolean;
}
```

The resolved closure and projected lockfile are returned for tooling that needs to inspect the
result.

## Current scope

- npm is the only package-manager backend currently implemented.
- Packaging the deployment folder into `.zip` or `.tgz` is intentionally out of scope.
- Peer dependency compatibility is not revalidated.
- A `file:` dependency outside the repository is allowed, but it can reduce reproducibility.
- Distinct local sources under the same dependency name are rejected; use different dependency
  aliases. A local and registry package cannot both require the same deployment-root slot.
- The acceptance suite does not establish support for bundled local packages or arbitrary
  conflicting peer groups. Git source classification is tested, but live Git installs are not.

## Contributors

The detailed behavioral contract and architecture are documented in [SPEC.md](SPEC.md).

Install dependencies and run the checks from the repository directory:

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

The [scenario coverage matrix](SPEC.md#14-scenario-coverage) distinguishes structural tests from
actual npm installation tests. Source coverage can be measured with Node's built-in runner:

```sh
node --test --experimental-test-coverage --test-coverage-include="src/**/*.ts" --import tsx "tests/**/*.test.ts"
```
