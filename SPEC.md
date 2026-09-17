# Spec: ws-deploy

## 1. Purpose

Build a tool that produces a **self-contained deployment folder** for a single npm-workspace package.

The tool must:

1. Copy the target workspace files to a deployment folder.
2. Discover and process **workspace dependencies** recursively.
3. Discover and process **file dependencies** such as `file:../lib`.
4. Project the repository `package-lock.json` into a **filtered deployment lockfile** that contains only the dependency closure of the target workspace.
5. Preserve the exact dependency versions from the repository lockfile.
6. Install or materialize all runtime dependencies into the deployment folder without including unrelated workspaces.

---

## 2. Problem Statement

In an npm monorepo, the repository lockfile and repository `node_modules` represent the dependency graph for the **entire repository**, not for one workspace alone.

A target workspace like `foo` may depend on:

- registry packages, for example `somelib`
- other workspace packages, for example `lib`
- file dependencies, for example `file:../lib`

The deploy artifact must contain only the **runtime closure of `foo`**, not the whole repository.

The tool must avoid these incorrect behaviors:

- copying the entire monorepo
- relying on `npm install` to resolve semver ranges again
- including unrelated workspaces such as `bar`
- assuming repository `node_modules` can be reused as-is in the deployment
- ignoring workspace or file dependencies

---

## 3. Design Principles

### 3.1 Source of truth

The **repository `package-lock.json`** is the source of truth for exact versions and resolved dependency metadata.
If the repository also contains `npm-shrinkwrap.json`, the shrinkwrap takes precedence, matching
npm. Both inputs must use lockfile version 2 or later and contain a valid `packages` map.

### 3.2 No re-resolution

The tool must **not** let the package manager choose newer compatible versions during deployment install.

### 3.3 Graph projection, not path translation

**The single most important rule: never "move" repository lockfile entries into the deployment by path
substitution.** Instead, the tool must:

- compute the dependency closure of the target workspace
- project that closure into a _new_ deployment dependency graph
- emit a filtered lockfile for that graph
- install or materialize from that filtered lockfile

This projection is the only robust way to support workspace deps, file deps, multiple versions
of the same package, exact-version fidelity, and exclusion of unrelated workspaces.

### 3.4 Workspace and file dependencies are installed from local sources

Any dependency declared as:

- workspace dependency
- `file:` dependency

must be converted into a local `file:` dependency. By default, npm packs it directly from its
source directory into `node_modules` using `--install-links`. When `copyLocalPackages` is enabled,
the package is first staged by:

- copying the package folder into the deployment

### 3.5 Registry dependencies remain registry dependencies

Packages from npm registry such as `somelib` should remain normal package dependencies in the filtered lockfile, with exact versions copied from the repository lockfile.

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

### 4.4 Deployment directory

The directory created for deployment. The **target workspace is the deployment package**: its
rewritten `package.json` is the deployment manifest, placed at the top level of the deployment
folder rather than nested under a `packages/*` path. Packaging it into an archive (`.zip`/`.tgz`)
is out of scope; leave that to dedicated tools.

### 4.5 Filtered lockfile

A new lockfile generated for the deployment directory that contains only the dependency graph reachable from the target workspace.

---

## 5. Functional Requirements

## FR1. Input parameters

The tool accepts:

- `repositoryDir`: path to the monorepo directory (default: cwd)
- `targetWorkspace`: workspace package name, for example `foo` (required)
- `deploymentDir`: output directory (default: `./deploy/<target>`)
- `installMode`: `npm-install`, `npm-ci` (default), or `none`
- `npmrc`: optional path to the npm configuration file used by the installation step
- `includeDevDependencies`: boolean, default `false`
- `includeOptionalDependencies`: boolean, default `false`
- `keepExistingDeploymentDir`: boolean, default `false` (when true, do not wipe an existing deployment directory)
- `copyLocalPackages`: boolean, default `false` (when true, stage local packages under `local-packages`)

---

## FR2. Discover workspace graph

The tool must parse the repository directory and discover all workspaces.

It must build a workspace graph containing:

- workspace package name
- package.json path
- package directory path
- dependency declarations
- scripts
- build output paths if configured

The graph must identify all workspace packages reachable from the target workspace through runtime edges.

---

## FR3. Copy target workspace files

The tool must copy the target workspace package into the deployment folder.

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
- repository-level unrelated files

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

Name matching is a classification hint, not permission to override a locked registry resolution.
An incompatible workspace version can resolve to a registry entry in the repository lockfile.
Explicit npm aliases, Git specs, and remote tarballs remain external even with matching names.

For each reachable workspace dependency:

1. include it in the closure
2. rewrite the target workspace package manifest to a `file:` reference relative to the deployment
3. when `copyLocalPackages` is enabled, copy it into the deployment folder and reference that copy
4. add a corresponding entry to the filtered deployment lockfile

The tool must process workspace dependencies recursively.

---

## FR5. Recognize and process file dependencies

The tool must detect file dependencies such as:

- `file:../lib`
- `file:../../shared/lib`

For each file dependency:

1. resolve the target package path
2. rewrite the dependency reference in the deployment manifest to the source path relative to the deployment
3. when `copyLocalPackages` is enabled, copy it into the deployment and reference that copy
4. add a corresponding entry to the filtered deployment lockfile

File dependencies should be treated similarly to workspace dependencies, except their source is path-based rather than workspace graph based.

Dependency keys are installation names, even when the local manifest declares a different name.
Children of packed file packages resolve from their installed repository lockfile location.
Local tarballs are retained as locked archive instances, not read as package directories. Their
references are rebased, or their bytes are copied under `local-tarballs/` in copy mode.

---

## FR6. Build the runtime dependency closure

Starting from the target workspace, the tool recursively traverses only runtime edges
(see §4.2): `dependencies`, plus `optionalDependencies` when `includeOptionalDependencies`
is set, plus `devDependencies` of the target only when `includeDevDependencies` is set.

Required peers of the target and local packages, and resolved peers of retained registry packages,
are traversed as install-graph edges.
Although peers are not runtime import edges, npm installs them by default and `npm ci` requires
their entries in the projected lockfile. Peers use the exact resolution from the repository lockfile and
are placed beside the package that declares them. Missing optional peers are omitted. ws-deploy
does not separately re-validate peer compatibility.

Optional declarations override regular and dev declarations of the same name. The selected
policy is reflected in emitted manifests and lock metadata, not only in traversal. Missing
optional local sources are omitted with warnings. Traversal must not mutate the input workspace
graph, and an optional subtree reached later through a required edge must be rechecked as required.

The closure must include:

- direct dependencies of the target workspace
- dependencies of those dependencies
- nested workspace dependencies
- nested file dependencies
- registry dependencies

The closure must exclude unrelated workspaces such as `bar`.

---

## FR7. Preserve exact versions from repository lockfile

The tool must use the exact resolved version from the repository `package-lock.json` for every registry dependency in the closure.

If the repository lockfile says:

- `lodash` resolves to `4.1.1` for one dependency path
- `lodash` resolves to `3.10.1` for another dependency path

the deployment lockfile must preserve both exact versions as separate resolution entries if needed.

The tool must not resolve `^4.0.0` again from the registry.

Identical names and versions do not imply identical package instances. Distinct resolved sources,
integrities, or resolved child graphs must be retained. Deduplication requires equivalent metadata
and dependency graphs, including cyclic graphs.

---

## FR8. Generate a filtered deployment lockfile

The tool must generate a deployment lockfile that contains only the dependency subgraph of the target workspace.

The filtered lockfile must include:

- the target workspace package
- all reachable workspace packages
- all reachable registry packages
- exact versions from the repository lockfile
- dependency relationships only for the reachable subgraph
- integrity and resolved metadata where available
- source-relative or staged `file:` references for workspace/file dependencies

The filtered lockfile must omit:

- unrelated workspace packages
- unrelated registry packages
- unrelated dependency branches

When one name has several demanded versions, their placement (which version sits at the
the deployment's top-level `node_modules` vs. nested under a consumer) follows the greedy most-used rule in §8.1.

---

## FR9. Reconstruct installable deployment tree

The tool must ensure the deployment folder is installable as a standalone package.

The **target workspace is the deployment package**: its rewritten `package.json` is written at the
top level (the lockfile's `packages[""]` deployment entry), and its runtime dependencies live
beneath it. The deployment directory must contain:

- target package files
- filtered `package.json`
- filtered lockfile
- installed workspace/file dependencies under `node_modules`
- a package manager installable graph

Install is performed by npm (`npm ci`/`npm install`) behind a pluggable `InstallerAdapter`
seam (see NFR5). Whichever backend runs must:

- honor the filtered lockfile
- introduce no new semver resolution
- reproduce the selected exact versions

The output is the deployment folder itself. Packaging it into an archive is intentionally out
of scope; use a dedicated archiving tool if a single-file artifact is needed.

---

# 6. Non-Functional Requirements

## NFR1. Determinism

Running the tool on the same repository state must produce the same deployment output, assuming the repository lockfile and workspace files are unchanged.

## NFR2. Reproducibility

The output should be reproducible without contacting the registry again for already locked versions, except where install tooling inherently needs package fetches.

## NFR3. Minimality

The output must not include unrelated workspaces or dependencies.

## NFR4. Safety

The tool must never modify the source monorepo files in place.
Output/source overlaps, including resolved symlinks and junctions, must be rejected before any
deletion or copying. This protects unrelated workspace sources as well as retained local sources.

## NFR5. Extensibility

The package-manager backend is a pluggable `InstallerAdapter`. npm is the only implemented
backend today; the seam keeps future pnpm/yarn support possible without changing the pipeline.

---

# 7. Architecture and interfaces

Each module maps to one internal interface:

| Module                  | Responsibility                                                                                      | Interface                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Workspace Graph Loader  | Read workspace config, discover packages, parse manifests, build the graph                          | `loadWorkspaceGraph(repositoryDir)`; `resolveTargetWorkspace(graph, target)` |
| Dependency Classifier   | Classify each edge as workspace / file / registry / peer / dev                                      | `classifyDependency(name, specifier, workspaceNames)`                   |
| Closure Resolver        | Traverse runtime edges from the target, collect local + registry packages                           | `computeRuntimeClosure(graph, lockfile, target, options)`               |
| Lockfile Projector      | Extract the reachable subgraph, preserve exact versions, apply placement (§8.1), rewrite local refs | `projectLockfile(repositoryLockfile, closure, deploymentManifest)`      |
| Deployment Materializer | Copy target, optionally stage local deps, and rewrite local references                                | `materialize(closure, repositoryManifest, options)`                     |
| Installer Adapter       | Run the chosen PM with the filtered lockfile, npm config, and inclusion policies                    | `getInstaller().install(deploymentDir, mode, npmrc?, policies?)`         |
| Validator               | Check the deployment folder is complete and installable                                             | `validateDeployment(deploymentDir, closure, options)`                   |

---

# 8. Pipeline

The run is a fixed sequence of stages; each maps to a requirement above.

1. **Load** — read the repository `package.json`, repository `package-lock.json`, and workspace manifests; build the graph (FR2).
2. **Resolve target** — locate the target node; fail early if missing (FR1, §11).
3. **Compute closure** — traverse runtime edges, classifying each as workspace / file / registry (FR4–FR6).
4. **Materialize** — copy the target and rewrite workspace/`file:` specifiers to source-relative `file:` refs. When `copyLocalPackages` is enabled, also copy every local dep into `local-packages/<name>` and rewrite local manifests to deployment-local refs (FR3–FR5, §3.4).
5. **Project lockfile** — emit the filtered deployment lockfile: exact versions from the repository lockfile, local deps as regular `file:` entries by default or `link` entries in copy mode, unrelated packages omitted, placement per §8.1 (FR7, FR8).
6. **Install** — when `installMode !== none`, run npm with `--install-links`, honoring the filtered lockfile (FR9).
7. **Validate** — check the deployment folder is complete and installable (FR9, §11).

## 8.1 Registry placement — greedy most-used hoisting

FR7/FR8 require that every consumer resolves the _exact_ locked version it demanded and
that all demanded versions of a name are retained. When a name has more than one demanded
version, the projector must decide which single version is placed in the deployment's top-level
`node_modules/<name>` and which versions are nested under the specific consumers that need
them. The deployment directory contains the target workspace as its top-level package, so the
monorepo's original layout must not be reused; the layout is recomputed from the closure.

The placement rule is **greedy most-used hoisting**:

1. **Choose the top-level deployment version of each name.** For every registry package name in the closure:

- If the deployment package directly depends on that name, the top-level version is the
  version it demands. **Direct deployment dependencies always win**, even if a different version
  is more common in the closure.
- Otherwise, choose the **most-used version**: the version demanded by the greatest number
  of consumers, counting every dependency edge in the closure (top-level demands plus every
  transitive registry edge) that requires each version.
- Ties (equal counts) are broken deterministically by ascending version order (NFR1).

2. **Place each demand relative to its consumer scope.** For a demand of `name@version` made
   by a consumer at scope `S` (the deployment package is scope `""`; a nested package's scope is
   its own `node_modules` directory):
   - Walk from `S` up its ancestor scopes to the deployment package scope. The **nearest ancestor scope that
     already hosts `name`** is reused when its hosted version equals `version`; if that
     ancestor hosts a _different_ version, `version` must nest directly under the consumer `S`.
   - If no ancestor yet hosts `name`, the package hoists to the deployment's top-level
     `node_modules` when `version` equals the chosen top-level deployment version; otherwise it
     nests directly under the consumer `S`.

3. **One version per scope.** A given scope's `node_modules` hosts at most one version of any
   name. Reaching a second version for the same scope is an internal error.

4. **Recurse from the placement scope.** After a package is placed at scope `T`, its own
   registry dependencies are placed relative to `T` (in a stable, sorted order), so conflicts
   deeper in the graph nest under the package that introduced them.

This produces a deterministic, npm-compatible layout: the most-used (or directly pinned) version
is shared in the deployment's top-level `node_modules`, and every conflicting minority version is
nested under exactly the consumers that demand it.

Placement compares exact instance identities, not just version strings. Version order remains the
primary tie-breaker, followed by the instance key. Existing local install slots are reserved;
transitive registry conflicts must nest instead of overwriting them. A local and registry package
that both require the deployment-root slot produce a diagnostic rather than silent replacement.

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
  specifier: string            // e.g. "^4.0.0", "workspace:*", "file:../lib"
  kind: "workspace" | "file" | "registry" | "peer" | "dev"
  group: "prod" | "optional" | "peer" | "dev"   // originating manifest section
  resolvedVersion?: string
  resolvedPath?: string
}
```

## 9.3 Closure artifacts

The closure is not a flat inventory; it is a `RuntimeClosure`:

```text
RuntimeClosure {
  target: WorkspaceNode
  includeOptionalDependencies: boolean
  localDependencies: Map<name, DeployLocalDependency>   // workspace/file deps to install or stage
  localResolutions: Map<sourcePath, Map<dependencyName, localName>>
  registryPackages: Map<instanceKey, ClosureRegistryPackage>
  topDemands: RegistryDemand[]   // { location, instanceKey } direct registry demands
  warnings: string[]
}

DeployLocalDependency {
  name; sourceType: "workspace" | "file"; sourcePath; version; manifest
  optional?: boolean
  deploymentRelativePath   // e.g. "local-packages/lib"
  deploymentReference      // e.g. "file:./local-packages/lib"
}

ClosureRegistryPackage {
  name; version; lockfileKey
  optional?: boolean
  localTarball?: { sourcePath; deploymentRelativePath }
  dependencies: string[]       // opaque instance keys; context suffixes distinguish same versions
  peerDependencies: string[]   // resolved peers placed beside the dependent package
}
```

## 9.4 Filtered lockfile

An npm lockfile document with `lockfileVersion` copied from the validated repository lockfile:

```text
FilteredLockfile {
  name; version; lockfileVersion; requires: true
  packages: Record<string, LockfilePackageEntry>   // "" is the deployment package entry
}
```

Local deps appear as regular `file:` entries by default, or as a `link` entry plus a target entry
when `copyLocalPackages` is enabled; registry packages carry exact
`version`/`resolved`/`integrity` copied from the repository lockfile. The legacy top-level
`dependencies` map (lockfile v1) is not emitted.
Local package entries also include rewritten dependency relationships and npm runtime metadata.
Any target shrinkwrap copied into the output is removed so the projected lockfile is authoritative.

---

# 10. Edge Cases

## EC1. Multiple versions of the same package

If `foo` depends on `lodash@4` and `somelib` depends on `lodash@3`, the deployment lockfile
retains both exact versions, placed per §8.1 (FR7).

## EC2. Workspace dependency with external dependencies

If `lib` is a workspace package and it depends on `lodash`, the tool must install `lib` and also include `lib`’s external dependency closure. It is copied into `local-packages` only when `copyLocalPackages` is enabled.

## EC3. File dependency chain

If `foo` depends on `file:../lib` and `lib` depends on `file:../shared`, the tool must recursively resolve and stage both.

## EC4. Peer dependencies

Required target/local peers and resolved registry-package peers are traversed so
the filtered lockfile remains valid for `npm ci` (FR6). Missing optional peers are omitted. Peer
compatibility is not separately re-validated; explicit peer-conflict validation remains a possible
future feature.

## EC5. Optional dependencies

Optional dependencies are traversed when explicitly enabled. npm applies `os`, `cpu`, and related
platform restrictions at install time. Missing optional installations are permitted by validation;
the same package reached through a required edge is not optional.

## EC6. Build-only outputs

If a package requires build output to execute, the deployment process must include the built artifacts, not just source files.

---

# 11. Error handling

## 11.1 Hard errors (abort the run)

- target workspace not found
- a workspace dependency does not resolve to a known workspace package
- a `file:` dependency has no `package.json` at the resolved path
- repository lockfile missing, or has no `packages` map
- output directory overlaps a source package
- distinct local sources use the same dependency name (use distinct aliases)
- **a required runtime dependency is reachable but has no entry in the repository lockfile** — the
  lockfile is out of sync with the manifests; omitting it would ship a broken artifact (§3.1)
- a placement invariant is violated (two versions demanded for one scope)
- deployment validation fails (missing deployment manifest, an un-materialized local package,
  a missing required installation, or a registry version differing from the projected lockfile)
- the installer exits non-zero

Messages should name the dependency, the offending path or parent package, and the reason.

## 11.2 Warnings (recorded, non-fatal)

- an **optional** dependency is not found in the repository lockfile → omitted (legitimate for
  platform-specific optionals)
- an optional workspace, directory, or local tarball source is unavailable
- a manifest entry references a workspace/`file:` package outside the closure → dropped from
  the rewritten manifest

## 11.3 Optional policies (not enforced by default)

- **Out-of-repository file dependencies.** A `file:` specifier that resolves outside the monorepo
  directory is staged as-is today. Because it depends on a path not under the repository's version
  control, it can break reproducibility (NFR1/NFR2); a future opt-in policy may reject such
  dependencies. It is not a hard error by default, since some setups legitimately reference
  sibling checkouts.

---

# 12. Acceptance Criteria

The implementation is correct if all of the following are true:

## AC1. Unrelated workspace exclusion

Given a monorepo with `foo`, `bar`, and `lib`, if `foo` does not depend on `bar`, then `bar`
— its files, dependencies, and lockfile entries — is absent from the deployment folder and the
filtered lockfile.

## AC2. Workspace dependency inclusion

If `foo` depends on workspace `lib`, then `lib` is copied into the deployment and included in the deployment lockfile.

## AC3. File dependency inclusion

If `foo` depends on `file:../lib`, then `lib` is resolved, copied into the deployment, and referenced from the deployment `package.json` and deployment lockfile.

## AC4. Registry dependency preservation

If the repository lockfile locks `lodash@4.1.1`, the deployment must use `4.1.1` and must not upgrade to `4.2.0` just because the semver range allows it.

## AC5. Transitive registry dependency inclusion

If `foo` depends on `somelib` and `somelib` depends on `lodash@3`, then the deployment graph must include both `somelib` and `lodash@3`.

## AC6. Multiple version support

If both `foo` and `somelib` require different locked versions of `lodash`, both versions must be present in the filtered deployment lockfile (see FR7, EC1).

---

# 13. Implementation notes

Build in dependency order, because projection and materialization need an accurate graph:

1. Workspace discovery and graph building.
2. Runtime closure traversal.
3. File/workspace reference rewriting and optional materialization.
4. Lockfile projection (including placement, §8.1).
5. Deployment install.
6. Validation of the deployment folder.

# 14. Scenario Coverage

The suite uses temporary repositories and, for npm acceptance tests, isolated loopback tarball
servers. Structural tests do not substitute for npm installability checks.

| Scenario | Verification |
| --- | --- |
| Workspace protocols, nested/scoped workspaces, recursive file dependencies | Closure and deployment integration tests; recursive npm ci in both copy modes |
| Same-name external specs and registry fallback for workspace versions | Classifier tests and locked deployment integration tests |
| Local dependency aliases and packed-file child resolution | Deployment integration and real npm ci in both copy modes |
| Local tarballs, copied archives, exact integrity, disabled lifecycle scripts | Real npm ci and npm install in both copy modes |
| Required target/local/registry peers and optional peer omission | Closure tests and real npm ci, including NODE_ENV=production |
| Optional precedence, graph reuse, required promotion, missing local sources | Closure and deployment integration tests |
| Platform-incompatible optional registry and local packages | Real npm ci, including copy and source-reference modes |
| Hoisting, direct-version priority, ties, cycles, same-version context differences | Lockfile projection tests; multiple-version npm ci acceptance |
| Local/registry slot collisions and ambiguous local-source identities | Projection and deployment rejection tests |
| Shrinkwrap precedence, lockfile v2, malformed/missing inputs | Lockfile integration tests |
| Output overlaps, directory links, keep-existing output | Deployment safety tests with source-preservation assertions |
| files, nested .npmignore, runtime assets, bin, source shrinkwrap | Package-content integration tests |
| Missing/wrong-version installed registry packages and optional omission | Post-install validation tests |
| npmrc propagation and explicit inclusion overriding environment defaults | CLI npm acceptance tests |

These tests do not establish complete npm feature parity. Bundled local packages, live Git
installation, and arbitrary conflicting peer groups remain outside the acceptance matrix.
Distinct local sources sharing one dependency name, and conflicting local/registry root slots,
are explicitly rejected rather than silently collapsed.

The overriding rule is stated in §3.3: project the reachable subgraph into a new lockfile —
never path-substitute repository lockfile entries. That is what makes workspace deps, file deps,
multiple versions of one package, exact-version fidelity, and workspace exclusion all work.
