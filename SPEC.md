# Spec: ws-deploy

## 1. Purpose

Build a tool that produces a **self-contained deployment folder** for a single npm-workspace package.

The tool must:

1. Copy the target workspace files to a deployment folder.
2. Discover and process **workspace dependencies** recursively.
3. Discover and process **file dependencies** such as `file:../lib`.
4. Project the root `package-lock.json` into a **filtered deployment lockfile** that contains only the dependency closure of the target workspace.
5. Preserve the exact dependency versions from the root lockfile.
6. Install or materialize all runtime dependencies into the deployment folder without including unrelated workspaces.

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
- assuming root `node_modules` can be reused as-is in the deployment
- ignoring workspace or file dependencies

---

## 3. Design Principles

### 3.1 Source of truth

The **root `package-lock.json`** is the source of truth for exact versions and resolved dependency metadata.

### 3.2 No re-resolution

The tool must **not** let the package manager choose newer compatible versions during deployment install.

### 3.3 Graph projection, not path translation

**The single most important rule: never "move" root lockfile entries into the deployment by path
substitution.** Instead, the tool must:

- compute the dependency closure of the target workspace
- project that closure into a _new_ deployment dependency graph
- emit a filtered lockfile for that graph
- install or materialize from that filtered lockfile

This projection is the only robust way to support workspace deps, file deps, multiple versions
of the same package, exact-version fidelity, and exclusion of unrelated workspaces.

### 3.4 Workspace and file dependencies are materialized locally

Any dependency declared as:

- workspace dependency
- `file:` dependency

must be converted into a deployment-local artifact by:

- copying the package folder into the deployment

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

### 4.4 Deployment root

The directory created for deployment. The **target workspace is the root package** of this
directory: its (rewritten) `package.json` is the root manifest, placed at the top level of the
deployment folder — not nested under a `packages/*` path. The deployment folder is rooted at the
target workspace. Packaging it into an archive (`.zip`/`.tgz`) is out of scope — leave that to
dedicated tools.

### 4.5 Filtered lockfile

A new lockfile generated for the deployment root that contains only the dependency graph reachable from the target workspace.

---

## 5. Functional Requirements

## FR1. Input parameters

The tool accepts:

- `repoRoot`: path to monorepo root (default: cwd)
- `targetWorkspace`: workspace package name, for example `foo` (required)
- `deployDir`: output directory (default: `./deploy/<target>`)
- `installMode`: `npm-install`, `npm-ci` (default), or `none`
- `includeDevDependencies`: boolean, default `false`
- `includeOptionalDependencies`: boolean, default `false`
- `keepExistingDeployDir`: boolean, default `false` (when true, do not wipe an existing deployment directory)

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
2. copy it into the deployment folder
3. rewrite the target workspace package manifest so the dependency points to the deployment-local copy
4. add a corresponding entry to the filtered deployment lockfile

The tool must process workspace dependencies recursively.

---

## FR5. Recognize and process file dependencies

The tool must detect file dependencies such as:

- `file:../lib`
- `file:../../shared/lib`

For each file dependency:

1. resolve the target package path
2. copy the dependency into the deployment
3. rewrite the dependency reference in the deployment manifest so it points to the deployment-local copy
4. add a corresponding entry to the filtered deployment lockfile

File dependencies should be treated similarly to workspace dependencies, except their source is path-based rather than workspace graph based.

---

## FR6. Build the runtime dependency closure

Starting from the target workspace, the tool recursively traverses only runtime edges
(see §4.2): `dependencies`, plus `optionalDependencies` when `includeOptionalDependencies`
is set, plus `devDependencies` of the target only when `includeDevDependencies` is set.

Resolved peer dependencies of retained registry packages are traversed as install-graph edges.
Although peers are not runtime import edges, npm installs them by default and `npm ci` requires
their entries in the projected lockfile. Peers use the exact resolution from the root lockfile and
are placed beside the package that declares them. Missing optional peers are omitted. ws-deploy
does not separately re-validate peer compatibility.

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

the deployment lockfile must preserve both exact versions as separate resolution entries if needed.

The tool must not resolve `^4.0.0` again from the registry.

---

## FR8. Generate a filtered deployment lockfile

The tool must generate a deployment lockfile that contains only the dependency subgraph of the target workspace.

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

When one name has several demanded versions, their placement (which version sits at the
deployment root vs. nested under a consumer) follows the greedy most-used rule in §8.1.

---

## FR9. Reconstruct installable deployment tree

The tool must ensure the deployment folder is installable as a standalone package root.

The **target workspace is the root of the deployment folder**: its rewritten `package.json` is
written at the top level (the lockfile's `""` root entry), and its runtime dependencies live
beneath it. The deployment root must contain:

- target package files
- filtered `package.json`
- filtered lockfile
- local copies of workspace/file dependencies
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

Running the tool on the same repo state must produce the same deployment output, assuming the root lockfile and workspace files are unchanged.

## NFR2. Reproducibility

The output should be reproducible without contacting the registry again for already locked versions, except where install tooling inherently needs package fetches.

## NFR3. Minimality

The output must not include unrelated workspaces or dependencies.

## NFR4. Safety

The tool must never modify the source monorepo files in place.

## NFR5. Extensibility

The package-manager backend is a pluggable `InstallerAdapter`. npm is the only implemented
backend today; the seam keeps future pnpm/yarn support possible without changing the pipeline.

---

# 7. Architecture and interfaces

Each module maps to one internal interface:

| Module                  | Responsibility                                                                                      | Interface                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Workspace Graph Loader  | Read workspace config, discover packages, parse manifests, build the graph                          | `loadWorkspaceGraph(repoRoot)`; `resolveTargetWorkspace(graph, target)` |
| Dependency Classifier   | Classify each edge as workspace / file / registry / peer / dev                                      | `classifyDependency(name, specifier, workspaceNames)`                   |
| Closure Resolver        | Traverse runtime edges from the target, collect local + registry packages                           | `computeRuntimeClosure(graph, lockfile, target, options)`               |
| Lockfile Projector      | Extract the reachable subgraph, preserve exact versions, apply placement (§8.1), rewrite local refs | `projectLockfile(rootLockfile, closure, rootManifest)`                  |
| Deployment Materializer | Copy target + local deps, rewrite manifests to deployment-local `file:` refs                        | `materialize(closure, options)`                                         |
| Installer Adapter       | Run the chosen PM install honoring the lockfile, no re-resolution                                   | `getInstaller().install(deployDir, mode)`                               |
| Validator               | Check the deployment folder is complete and installable                                             | `validateDeployment(deployDir, closure, options)`                       |

---

# 8. Pipeline

The run is a fixed sequence of stages; each maps to a requirement above.

1. **Load** — read root `package.json`, root `package-lock.json`, and workspace manifests; build the graph (FR2).
2. **Resolve target** — locate the target node; fail early if missing (FR1, §11).
3. **Compute closure** — traverse runtime edges, classifying each as workspace / file / registry (FR4–FR6).
4. **Materialize** — copy the target and every local dep into `local-packages/<name>`, and rewrite manifests so workspace/`file:` specifiers become deployment-local `file:` refs; e.g. `workspace:*` and `file:../lib` both become `file:./local-packages/lib` (FR3–FR5, §3.4).
5. **Project lockfile** — emit the filtered deployment lockfile: exact versions from the root lockfile, local deps as `link` entries, unrelated packages omitted, placement per §8.1 (FR7, FR8).
6. **Install** — when `installMode !== none`, run npm honoring the filtered lockfile (FR9).
7. **Validate** — check the deployment folder is complete and installable (FR9, §11).

## 8.1 Registry placement — greedy most-used hoisting

FR7/FR8 require that every consumer resolves the _exact_ locked version it demanded and
that all demanded versions of a name are retained. When a name has more than one demanded
version, the projector must decide which single version is placed at the deployment root
`node_modules/<name>` and which versions are nested under the specific consumers that need
them. The deployment root is a _new_ root (the target workspace), so the monorepo's original
layout must not be reused; the layout is recomputed from the closure.

The placement rule is **greedy most-used hoisting**:

1. **Choose the root version of each name.** For every registry package name in the closure:

- If the deployment root package directly depends on that name, the root version is the
  version the root demands. **Root direct dependencies always win**, even if a different
  version is more common in the closure.
- Otherwise, choose the **most-used version**: the version demanded by the greatest number
  of consumers, counting every dependency edge in the closure (top-level demands plus every
  transitive registry edge) that requires each version.
- Ties (equal counts) are broken deterministically by ascending version order (NFR1).

2. **Place each demand relative to its consumer scope.** For a demand of `name@version` made
   by a consumer at scope `S` (the deployment root is scope `""`; a nested package's scope is its
   own `node_modules` directory):
   - Walk from `S` up its ancestor scopes to the root. The **nearest ancestor scope that
     already hosts `name`** is reused when its hosted version equals `version`; if that
     ancestor hosts a _different_ version, `version` must nest directly under the consumer `S`.
   - If no ancestor yet hosts `name`, the package hoists to the root when `version` equals the
     chosen root version; otherwise it nests directly under the consumer `S`.

3. **One version per scope.** A given scope's `node_modules` hosts at most one version of any
   name. Reaching a second version for the same scope is an internal error.

4. **Recurse from the placement scope.** After a package is placed at scope `T`, its own
   registry dependencies are placed relative to `T` (in a stable, sorted order), so conflicts
   deeper in the graph nest under the package that introduced them.

This produces a deterministic, npm-compatible layout: the most-used (or root-pinned) version
is shared at the root, and every conflicting minority version is nested under exactly the
consumers that demand it.

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
  localDependencies: Map<name, DeployLocalDependency>   // workspace/file deps to copy
  registryPackages: Map<"name@version", ClosureRegistryPackage>
  topDemands: RegistryDemand[]   // { location, instanceKey } direct registry demands
  warnings: string[]
}

DeployLocalDependency {
  name; sourceType: "workspace" | "file"; sourcePath; version; manifest
  deployRelativePath   // e.g. "local-packages/lib"
  deployReference      // e.g. "file:./local-packages/lib"
}

ClosureRegistryPackage {
  name; version; lockfileKey
  dependencies: string[]       // "name@version" instance keys
  peerDependencies: string[]   // resolved peers placed beside the dependent package
}
```

## 9.4 Filtered lockfile

An npm lockfile v3 document (`lockfileVersion` copied from the root when ≥ 2, else 3):

```text
FilteredLockfile {
  name; version; lockfileVersion; requires: true
  packages: Record<string, LockfilePackageEntry>   // "" is the deployment root
}
```

Local deps appear as a `link` entry plus a target entry; registry packages carry exact
`version`/`resolved`/`integrity` copied from the root lockfile. The legacy top-level
`dependencies` map (lockfile v1) is not emitted.

---

# 10. Edge Cases

## EC1. Multiple versions of the same package

If `foo` depends on `lodash@4` and `somelib` depends on `lodash@3`, the deployment lockfile
retains both exact versions, placed per §8.1 (FR7).

## EC2. Workspace dependency with external dependencies

If `lib` is a workspace package and it depends on `lodash`, the tool must copy `lib` and also include `lib`’s external dependency closure.

## EC3. File dependency chain

If `foo` depends on `file:../lib` and `lib` depends on `file:../shared`, the tool must recursively resolve and stage both.

## EC4. Peer dependencies

Resolved peers of retained registry packages are traversed and placed beside their dependents so
the filtered lockfile remains valid for `npm ci` (FR6). Missing optional peers are omitted. Peer
compatibility is not separately re-validated; explicit peer-conflict validation remains a possible
future feature.

## EC5. Optional dependencies

Optional dependencies should be included only if the deployment target platform requires them or if the policy says to include them.

## EC6. Build-only outputs

If a package requires build output to execute, the deployment process must include the built artifacts, not just source files.

---

# 11. Error handling

## 11.1 Hard errors (abort the run)

- target workspace not found
- a workspace dependency does not resolve to a known workspace package
- a `file:` dependency has no `package.json` at the resolved path
- root lockfile missing, or has no `packages` map
- **a required runtime dependency is reachable but has no entry in the root lockfile** — the
  lockfile is out of sync with the manifests; omitting it would ship a broken artifact (§3.1)
- a placement invariant is violated (two versions demanded for one scope)
- deployment validation fails (missing root manifest, an un-materialized local dep, or — after
  install — a local dep missing from `node_modules`)
- the installer exits non-zero

Messages should name the dependency, the offending path or parent package, and the reason.

## 11.2 Warnings (recorded, non-fatal)

- an **optional** dependency is not found in the root lockfile → omitted (legitimate for
  platform-specific optionals)
- a manifest entry references a workspace/`file:` package outside the closure → dropped from
  the rewritten manifest

## 11.3 Optional policies (not enforced by default)

- **Out-of-repo file dependencies.** A `file:` specifier that resolves outside the monorepo
  root is staged as-is today. Because it depends on a path not under the repo's version
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

If root lockfile locks `lodash@4.1.1`, the deployment must use `4.1.1` and must not upgrade to `4.2.0` just because the semver range allows it.

## AC5. Transitive registry dependency inclusion

If `foo` depends on `somelib` and `somelib` depends on `lodash@3`, then the deployment graph must include both `somelib` and `lodash@3`.

## AC6. Multiple version support

If both `foo` and `somelib` require different locked versions of `lodash`, both versions must be present in the filtered deployment lockfile (see FR7, EC1).

---

# 13. Implementation notes

Build in dependency order, because projection and materialization need an accurate graph:

1. Workspace discovery and graph building.
2. Runtime closure traversal.
3. File/workspace dependency materialization.
4. Lockfile projection (including placement, §8.1).
5. Deployment install.
6. Validation of the deployment folder.

The overriding rule is stated in §3.3: project the reachable subgraph into a new lockfile —
never path-substitute root lockfile entries. That is what makes workspace deps, file deps,
multiple versions of one package, exact-version fidelity, and workspace exclusion all work.
