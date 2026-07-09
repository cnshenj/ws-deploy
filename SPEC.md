# Spec: ws-pack

## 1. Purpose

Build a tool that creates a **self-contained archives** for npm workspaces.

The tool must:

1. Copy the target workspace files to a staging folder.
2. Discover and process **workspace dependencies** recursively.
3. Discover and process **file dependencies** such as `file:../lib`.
4. Project the root `package-lock.json` into a **filtered staging lockfile** that contains only the dependency closure of the target workspace.
5. Preserve the exact dependency versions from the root lockfile.
6. Install or materialize all runtime dependencies into the staging folder without including unrelated workspaces such as `bar`.

---

## 2. Problem Statement

In an npm monorepo, the root lockfile and root `node_modules` represent the dependency graph for the **entire repo**, not for one workspace alone.

A target workspace like `foo` may depend on:

- registry packages, for example `somelib`
- other workspace packages, for example `lib`
- file dependencies, for example `file:../lib`

The deploy artifact must contain only the **runtime closure of `foo`**, not the whole repository.

The tool must avoid these incorrect behaviors:

- copying the entire monorepo
- relying on `npm install` to resolve semver ranges again
- including unrelated workspaces such as `bar`
- assuming root `node_modules` can be reused as-is in staging
- ignoring workspace or file dependencies

---

## 3. Design Principles

### 3.1 Source of truth
The **root `package-lock.json`** is the source of truth for exact versions and resolved dependency metadata.

### 3.2 No re-resolution
The tool must **not** let the package manager choose newer compatible versions during staging install.

### 3.3 Graph projection, not path translation
The tool must not simply map root `node_modules` paths into staging paths.

Instead, it must:

- compute the dependency closure of the target workspace
- project that closure into a new staging dependency graph
- emit a filtered lockfile for that graph
- install or materialize from that filtered lockfile

### 3.4 Workspace and file dependencies are materialized locally
Any dependency declared as:

- workspace dependency
- `file:` dependency

must be converted into a staging-local artifact by:

- copying the package folder into staging

### 3.5 Registry dependencies remain registry dependencies
Packages from npm registry such as `somelib` should remain normal package dependencies in the filtered lockfile, with exact versions copied from the root lockfile.

---

## 4. Terminology

### 4.1 Workspace package
A package declared in the monorepo workspace set, such as `packages/foo`, `packages/lib`, `packages/bar`.

### 4.2 Runtime dependency
A dependency listed in:

- `dependencies`
- `optionalDependencies`

if it is required at runtime

Do not include:

- `devDependencies`
- test-only dependencies
- build-only dependencies

unless the deploy mode explicitly requests them.

### 4.3 Dependency closure
The set of all packages reachable from the target workspace via runtime dependency edges.

### 4.4 Staging root
The directory created for deployment, where the target workspace becomes the effective root package.

### 4.5 Filtered lockfile
A new lockfile generated for the staging root that contains only the dependency graph reachable from the target workspace.

---

## 5. Functional Requirements

## FR1. Input parameters

The tool must accept at least:

- `repoRoot`: path to monorepo root
- `targetWorkspace`: workspace package name, for example `foo`
- `stagingDir`: output directory
- `installMode`: install strategy, default `npm`
- `includeDevDependencies`: boolean, default `false`

---

## FR2. Discover workspace graph

The tool must parse the monorepo root and discover all workspaces.

It must build a workspace graph containing:

- workspace package name
- package.json path
- package root path
- dependency declarations
- scripts
- build output paths if configured

The graph must identify all workspace packages reachable from the target workspace through runtime edges.

---

## FR3. Copy target workspace files

The tool must copy the target workspace package into the staging folder.

It must include only what is needed for runtime execution and install:

- `package.json`
- built output files if applicable
- runtime assets
- config files required by runtime
- any files explicitly included by package manifest

It must exclude, by default:

- `node_modules`
- test files
- source files not needed for runtime if the package is already built
- repo-level unrelated files

The file selection logic must be configurable.

---

## FR4. Recognize and process workspace dependencies

The tool must detect dependencies that resolve to workspace packages using any of the following indicators:

- workspace protocol
- local workspace name match
- path-based local reference
- `workspace:*`
- `workspace:^`
- `workspace:~`

For each reachable workspace dependency:

1. include it in the closure
2. copy it into the staging folder
3. rewrite the target workspace package manifest so the dependency points to the staging-local copy
4. add a corresponding entry to the filtered staging lockfile

The tool must process workspace dependencies recursively.

---

## FR5. Recognize and process file dependencies

The tool must detect file dependencies such as:

- `file:../lib`
- `file:../../shared/lib`

For each file dependency:

1. resolve the target package path
2. copy the dependency into staging
3. rewrite the dependency reference in the staging manifest so it points to the staging-local copy
4. add a corresponding entry to the filtered staging lockfile

File dependencies should be treated similarly to workspace dependencies, except their source is path-based rather than workspace graph based.

---

## FR6. Build the runtime dependency closure

Starting from the target workspace, the tool must recursively traverse only runtime edges:

- `dependencies`
- `optionalDependencies` if enabled for target platform
- peer dependencies only for validation and required resolution, not as direct edges unless the package manifest requires them

The closure must include:

- direct dependencies of the target workspace
- dependencies of those dependencies
- nested workspace dependencies
- nested file dependencies
- registry dependencies

The closure must exclude unrelated workspaces such as `bar`.

---

## FR7. Preserve exact versions from root lockfile

The tool must use the exact resolved version from the root `package-lock.json` for every registry dependency in the closure.

If the root lockfile says:

- `lodash` resolves to `4.1.1` for one dependency path
- `lodash` resolves to `3.10.1` for another dependency path

the staging lockfile must preserve both exact versions as separate resolution entries if needed.

The tool must not resolve `^4.0.0` again from the registry.

---

## FR8. Generate a filtered staging lockfile

The tool must generate a staging lockfile that contains only the dependency subgraph of the target workspace.

The filtered lockfile must include:

- the target workspace package
- all reachable workspace packages
- all reachable registry packages
- exact versions from the root lockfile
- dependency relationships only for the reachable subgraph
- integrity and resolved metadata where available
- local copy references for workspace/file dependencies

The filtered lockfile must omit:

- unrelated workspace packages
- unrelated registry packages
- unrelated dependency branches

---

## FR9. Reconstruct installable staging tree

The tool must ensure the staging folder is installable as a standalone package root.

That means the staging root must contain:

- target package files
- filtered `package.json`
- filtered lockfile
- local copies of workspace/file dependencies
- a package manager installable graph

The tool may execute install using npm or pnpm as long as:

- the filtered lockfile is honored
- no new semver resolution is introduced
- the resulting installation reproduces the selected exact versions

---

## FR10. Archive output

The tool must optionally create an archive, for example:

- `.zip`
- `.tgz`
- or a deploy folder ready for packaging

The archive must contain only the staging closure of the target workspace and its runtime dependencies.

---

# 6. Non-Functional Requirements

## NFR1. Determinism
Running the tool on the same repo state must produce the same staging output, assuming the root lockfile and workspace files are unchanged.

## NFR2. Reproducibility
The output should be reproducible without contacting the registry again for already locked versions, except where install tooling inherently needs package fetches.

## NFR3. Minimality
The output must not include unrelated workspaces or dependencies.

## NFR4. Safety
The tool must never modify the source monorepo files in place.

## NFR5. Extensibility
The package manager backend should be pluggable so future support for npm, pnpm, or yarn is possible.

---

# 7. High-Level Architecture

The tool should be divided into the following modules:

## 7.1 Workspace Graph Loader
Responsible for:

- reading root workspace configuration
- discovering workspace packages
- parsing package.json files
- building workspace dependency graph

## 7.2 Dependency Classifier
Responsible for classifying dependency edges as:

- workspace dependency
- file dependency
- registry dependency
- peer dependency
- dev dependency

## 7.3 Closure Resolver
Responsible for:

- starting from the target workspace
- traversing runtime dependencies recursively
- collecting the exact set of packages needed for staging

## 7.4 Lockfile Projector
Responsible for:

- reading root package-lock.json
- extracting only entries reachable from the closure
- preserving exact versions and metadata
- rewriting local references for workspace/file dependencies
- writing filtered staging lockfile

## 7.5 Staging Materializer
Responsible for:

- copying target workspace files
- copying workspace/file dependencies
- rewriting package.json files in staging
- writing staging metadata

## 7.6 Installer Adapter
Responsible for:

- running the chosen package manager install in staging
- respecting the staging lockfile
- avoiding semver re-resolution

---

# 8. Detailed Algorithm

## Step 1. Load monorepo metadata

Read:

- root `package.json`
- root `package-lock.json`
- workspace package manifests
- any workspace configuration used by npm

Build a workspace registry:

- package name
- version
- path
- manifest
- direct dependencies
- dev dependencies
- peer dependencies
- optional dependencies

---

## Step 2. Resolve target workspace

Given `targetWorkspace = foo`:

- locate the package.json for `foo`
- verify it exists in workspace registry
- load its manifest

If the target workspace does not exist, fail early.

---

## Step 3. Compute runtime dependency closure

Walk the dependency graph recursively starting from `foo`.

For each dependency edge:

### Case A. Workspace dependency
If dependency references another workspace package, include that workspace package in the closure and continue traversal from it.

### Case B. File dependency
If dependency is `file:...`, resolve the path, treat it as a package node, include it in the closure, and continue traversal from it.

### Case C. Registry dependency
If dependency is from the registry, include it if it is reachable from the runtime graph and continue traversal using the root lockfile metadata.

### Case D. Dev dependency
Ignore unless `includeDevDependencies` is true.

---

## Step 4. Build staging inventory

Produce a staging inventory containing:

- target workspace package
- all reachable workspace dependencies
- all reachable file dependencies
- all reachable registry dependencies from the lockfile

For each inventory item record:

- package name
- source type
- source path or resolved version
- exact version from root lockfile
- dependency list
- file copy strategy

---

## Step 5. Materialize workspace and file dependencies

For each workspace or file dependency in the inventory:

Copy the package folder into a staging-local package directory.

Then update staging dependency references so the target package and any dependent staging package uses the staging-local copy reference.

Examples:

- `workspace:*` becomes `file:./_staging_deps/lib`
- `file:../lib` becomes `file:./_staging_deps/lib`

The exact form can vary, but the staging root must be self-contained.

---

## Step 6. Project root lockfile to staging lockfile

Create a new lockfile representing only the dependency closure of `foo`.

For each dependency in the closure:

1. find the exact resolved version in the root lockfile
2. include the package entry in the staging lockfile
3. preserve dependency edges
4. omit unrelated packages
5. rewrite local references for workspace/file dependencies to staging-local references

If the same package name appears multiple times with different resolved versions in the closure, keep all required versions as distinct entries according to the lockfile schema.

---

## Step 7. Rewrite staging `package.json`

The staging root `package.json` must be rewritten so that:

- the target package is the effective root
- workspace dependencies are replaced with staging-local references
- file dependencies are replaced with staging-local references
- registry dependencies keep their semver declarations or are pinned according to the staging strategy

If the install strategy requires exact versions in staging, the rewritten manifest may pin them to exact versions.

---

## Step 8. Install in staging

Run the selected installer in the staging directory.

Rules:

- it must use the filtered staging lockfile
- it must not resolve unrelated dependencies
- it must not pull in `bar`
- it must not upgrade locked versions
- it must honor local staging references for workspace/file dependencies

---

## Step 9. Validate output

Before archiving, validate:

- the target workspace exists in staging
- all direct runtime dependencies are present
- all workspace/file dependencies were materialized
- no unrelated workspaces exist in staging
- critical package versions match the root lockfile selections
- the staging tree is installable or already installed

---

## Step 10. Archive staging folder

Package the staging folder as the deployable artifact.

---

# 9. Data Model

## 9.1 WorkspaceNode

```text
WorkspaceNode {
  name: string
  version: string
  path: string
  manifestPath: string
  manifest: PackageJson
  dependencies: DependencyEdge[]
  devDependencies: DependencyEdge[]
  peerDependencies: DependencyEdge[]
  optionalDependencies: DependencyEdge[]
}
```

## 9.2 DependencyEdge

```text
DependencyEdge {
  fromPackage: string
  depName: string
  specifier: string
  type: "workspace" | "file" | "registry" | "peer" | "dev"
  resolvedVersion?: string
  resolvedPath?: string
  lockfileKey?: string
}
```

## 9.3 StagingInventoryItem

```text
StagingInventoryItem {
  name: string
  sourceType: "workspace" | "file" | "registry"
  sourcePath?: string
  sourceVersion?: string
  exactVersion?: string
  stagingPath: string
  stagingReference: string
  dependencies: string[]
}
```

## 9.4 FilteredLockfile

```text
FilteredLockfile {
  lockfileVersion: number
  packages: Record<string, LockfilePackageEntry>
  dependencies?: Record<string, DependencyEntry>
}
```

The exact schema must match the selected package manager’s lockfile format, but the conceptual model must preserve:

- exact versions
- dependency relationships
- integrity/resolved metadata
- staging-local copy references for workspace/file dependencies

---

# 10. Edge Cases

## EC1. Multiple versions of the same package
If `foo` depends on `lodash@4` and `somelib` depends on `lodash@3`, the staging lockfile must retain both exact versions.

## EC2. Workspace dependency with external dependencies
If `lib` is a workspace package and it depends on `lodash`, the tool must copy `lib` and also include `lib`’s external dependency closure.

## EC3. File dependency chain
If `foo` depends on `file:../lib` and `lib` depends on `file:../shared`, the tool must recursively resolve and stage both.

## EC4. Peer dependencies
Peer dependencies must be validated during closure resolution. If unresolved peers are required for runtime, the tool must fail with a clear error.

## EC5. Optional dependencies
Optional dependencies should be included only if the deployment target platform requires them or if the policy says to include them.

## EC6. Build-only outputs
If a package requires build output to execute, the staging process must include the built artifacts, not just source files.

---

# 11. Error Handling Requirements

The tool must fail with explicit errors for:

- target workspace not found
- workspace dependency path cannot be resolved
- file dependency points outside repo and is disallowed
- root lockfile missing or inconsistent
- exact version cannot be found in root lockfile
- peer dependency conflict in staging closure
- staging lockfile generation failed
- install failed in staging
- a dependency is reachable at runtime but not present in filtered lockfile

Error messages must include:

- dependency name
- package path
- parent package
- failure reason
- suggested fix

---

# 12. Acceptance Criteria

The implementation is correct if all of the following are true:

## AC1. Workspace exclusion
Given a monorepo with `foo`, `bar`, and `lib`, if `foo` does not depend on `bar`, then `bar` is absent from the staging folder and filtered lockfile.

## AC2. Workspace dependency inclusion
If `foo` depends on workspace `lib`, then `lib` is copied into staging and included in the staging lockfile.

## AC3. File dependency inclusion
If `foo` depends on `file:../lib`, then `lib` is resolved, copied into staging, and referenced from staging `package.json` and staging lockfile.

## AC4. Registry dependency preservation
If root lockfile locks `lodash@4.1.1`, staging must use `4.1.1` and must not upgrade to `4.2.0` just because the semver range allows it.

## AC5. Transitive registry dependency inclusion
If `foo` depends on `somelib` and `somelib` depends on `lodash@3`, then the staging graph must include both `somelib` and `lodash@3`.

## AC6. Multiple version support
If both `foo` and `somelib` require different locked versions of `lodash`, both versions must be present in the filtered staging lockfile.

## AC7. No unrelated workspace leakage
The staging artifact must not contain `bar`, its dependencies, or any unrelated workspace files.

---

# 13. Recommended Implementation Strategy

For a coding AI agent, the safest implementation strategy is:

1. Implement workspace discovery and graph building first.
2. Implement runtime closure traversal second.
3. Implement file/workspace dependency materialization third.
4. Implement lockfile projection fourth.
5. Implement staging install fifth.
6. Add validation and archive generation last.

This order is important because lockfile projection and staging materialization depend on an accurate dependency graph.

---

# 14. Suggested Internal Interfaces

## `loadWorkspaceGraph(repoRoot)`

Returns a graph of workspace nodes and their dependencies.

## `resolveTargetWorkspace(graph, targetWorkspace)`

Returns the resolved workspace node.

## `computeRuntimeClosure(graph, targetWorkspace, options)`

Returns the set of nodes needed for staging.

## `materializeLocalDependencies(closure, stagingDir, options)`

Copies workspace and file dependencies into staging.

## `projectLockfile(rootLockfile, closure, stagingManifestMap)`

Returns a filtered lockfile for the staging graph.

## `rewriteStagingManifests(closure, stagingManifestMap)`

Writes rewritten package.json files for staging.

## `installStagingDependencies(stagingDir, installMode)`

Runs the package manager install in staging.

## `validateStagingOutput(stagingDir, closure)`

Checks output correctness before archive.

## `archiveStagingDir(stagingDir, outputPath)`

Creates the final package.

---

# 15. Notes for the Coding AI Agent

The most important implementation rule is this:

> Do not attempt to “move” the root lockfile entries into staging by path substitution.

Instead:

1. compute the reachable dependency subgraph
2. preserve exact versions from root lockfile
3. materialize local dependencies into staging
4. generate a filtered lockfile for the subgraph
5. install from the filtered lockfile in staging

That is the only robust way to support:

- workspace dependencies
- file dependencies
- multiple versions of the same package
- exact version fidelity
- exclusion of unrelated workspaces

---
