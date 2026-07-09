/**
 * Shared data model for ws-pack.
 *
 * The conceptual model mirrors SPEC.md §9 but is adapted to the concrete
 * decisions taken for the implementation (npm-only, copy-to-`_staging_deps`,
 * `npm install` with a seeded filtered lockfile).
 */

/** A parsed `package.json` manifest. Only fields ws-pack cares about are typed. */
export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bundleDependencies?: string[];
  bundledDependencies?: string[];
  files?: string[];
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  [key: string]: unknown;
}

/** How a dependency edge resolves. */
export type DependencyKind = "workspace" | "file" | "registry" | "peer" | "dev";

/** How a runtime dependency contributes to the closure. */
export type DependencyGroup = "prod" | "optional" | "peer" | "dev";

/** A single dependency declaration on a package. */
export interface DependencyEdge {
  /** Package that declares the dependency. */
  fromPackage: string;
  /** Declared dependency name. */
  depName: string;
  /** Raw version specifier, e.g. `^4.0.0`, `workspace:*`, `file:../lib`. */
  specifier: string;
  /** Classification of the specifier. */
  kind: DependencyKind;
  /** Which manifest section the edge came from. */
  group: DependencyGroup;
  /** Exact version resolved from the root lockfile, when applicable. */
  resolvedVersion?: string;
  /** Absolute path a workspace/file dependency resolves to. */
  resolvedPath?: string;
}

/** A workspace package discovered in the monorepo. */
export interface WorkspaceNode {
  name: string;
  version: string;
  /** Absolute path to the package root directory. */
  path: string;
  /** Absolute path to the package's `package.json`. */
  manifestPath: string;
  manifest: PackageJson;
  dependencies: DependencyEdge[];
  devDependencies: DependencyEdge[];
  peerDependencies: DependencyEdge[];
  optionalDependencies: DependencyEdge[];
}

/** The discovered monorepo graph. */
export interface WorkspaceGraph {
  repoRoot: string;
  rootManifest: PackageJson;
  /** Workspace nodes keyed by package name. */
  nodes: Map<string, WorkspaceNode>;
}

/** Source classification for a materialized local dependency. */
export type LocalSourceType = "workspace" | "file";

/** An item that must be materialized (copied) into the staging folder. */
export interface StagingLocalDependency {
  name: string;
  sourceType: LocalSourceType;
  /** Absolute path to the source package directory. */
  sourcePath: string;
  version: string;
  manifest: PackageJson;
  /** Relative staging path, e.g. `_staging_deps/lib`. */
  stagingRelativePath: string;
  /** Reference written into dependent manifests, e.g. `file:./_staging_deps/lib`. */
  stagingReference: string;
}

/** A registry package that belongs to the runtime closure. */
export interface ClosureRegistryPackage {
  name: string;
  version: string;
  /** Lockfile key in the root lockfile, e.g. `node_modules/lodash`. */
  lockfileKey: string;
}

/** The full runtime closure of the target workspace. */
export interface RuntimeClosure {
  /** The target workspace node (staging root). */
  target: WorkspaceNode;
  /** Local (workspace/file) dependencies to copy, keyed by name. */
  localDependencies: Map<string, StagingLocalDependency>;
  /** Registry packages keyed by `name@version`. */
  registryPackages: Map<string, ClosureRegistryPackage>;
  /** Warnings collected during traversal (e.g. unresolved optional deps). */
  warnings: string[];
}

/** An npm lockfile v3 package entry (subset used by ws-pack). */
export interface LockfilePackageEntry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  license?: string;
  bin?: string | Record<string, string>;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** An npm lockfile v3 document (subset used by ws-pack). */
export interface NpmLockfile {
  name?: string;
  version?: string;
  lockfileVersion: number;
  requires?: boolean;
  packages: Record<string, LockfilePackageEntry>;
  [key: string]: unknown;
}

/** Strategy for producing the staging install. */
export type InstallMode = "npm-install" | "npm-ci" | "none";

/** Archive format for the final artifact. */
export type ArchiveFormat = "none" | "tgz" | "zip";

/** Options controlling a ws-pack run. */
export interface PackOptions {
  repoRoot: string;
  targetWorkspace: string;
  stagingDir: string;
  installMode?: InstallMode;
  includeDevDependencies?: boolean;
  includeOptionalDependencies?: boolean;
  archive?: ArchiveFormat;
  /** Fixed directory name (relative to staging root) for local deps. */
  localDepsDir?: string;
  /** When true, do not delete an existing staging directory. */
  keepExistingStaging?: boolean;
}

/** Result of a completed ws-pack run. */
export interface PackResult {
  stagingDir: string;
  closure: RuntimeClosure;
  lockfile: NpmLockfile;
  archivePath?: string;
  warnings: string[];
}
