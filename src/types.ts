/**
 * Shared data model for ws-deploy.
 *
 * The conceptual model mirrors SPEC.md §9 but is adapted to the concrete
 * decisions taken for the implementation (npm-only and a seeded filtered lockfile).
 */

import type { PackageJson as NpmPackageJson } from "@npmcli/package-json";

/** A parsed `package.json` manifest (npm's canonical `package.json` type). */
export type PackageJson = NpmPackageJson;

/** A dependency section (`dependencies`, `optionalDependencies`, ...). */
export type DependencyMap = Partial<Record<string, string>>;

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
  /** Exact version resolved from the repository lockfile, when applicable. */
  resolvedVersion?: string;
  /** Absolute path a workspace/file dependency resolves to. */
  resolvedPath?: string;
}

/** A workspace package discovered in the monorepo. */
export interface WorkspaceNode {
  name: string;
  version: string;
  /** Absolute path to the package directory. */
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
  repositoryDir: string;
  repositoryManifest: PackageJson;
  /** Workspace nodes keyed by package name. */
  nodes: Map<string, WorkspaceNode>;
}

/** Source classification for a local dependency. */
export type LocalSourceType = "workspace" | "file";

/** A local dependency that may be referenced from source or copied into the deployment folder. */
export interface DeployLocalDependency {
  name: string;
  optional?: boolean;
  sourceType: LocalSourceType;
  /** Absolute path to the source package directory. */
  sourcePath: string;
  version: string;
  manifest: PackageJson;
  /** Relative deployment path, e.g. `local-packages/lib`. */
  deploymentRelativePath: string;
  /** Reference written into dependent manifests, e.g. `file:./local-packages/lib`. */
  deploymentReference: string;
}

/** A registry package that belongs to the runtime closure. */
export interface ClosureRegistryPackage {
  name: string;
  version: string;
  optional?: boolean;
  localTarball?: { sourcePath: string; deploymentRelativePath: string };
  /** Lockfile key in the repository lockfile, e.g. `node_modules/lodash`. */
  lockfileKey: string;
  /** Registry dependency edges as opaque keys distinguishing locked source and dependency contexts. */
  dependencies: string[];
  /** Resolved peer edges that must be installed beside this package. */
  peerDependencies: string[];
}

/** A direct registry demand from the deployment package or a local dependency. */
export interface RegistryDemand {
  /** Deployment location: `""` for the deployment package, else a local dependency path. */
  location: string;
  /** The demanded registry package's instance key. */
  instanceKey: string;
}

/** The full runtime closure of the target workspace. */
export interface RuntimeClosure {
  /** The target workspace node copied to the deployment directory. */
  target: WorkspaceNode;
  includeOptionalDependencies?: boolean;
  /** Local (workspace/file) dependencies to install, keyed by name. */
  localDependencies: Map<string, DeployLocalDependency>;
  localResolutions?: Map<string, Map<string, string>>;
  /** Registry packages keyed by exact source/dependency instance identity. */
  registryPackages: Map<string, ClosureRegistryPackage>;
  /** Direct registry demands from the deployment package and each local dependency. */
  topDemands: RegistryDemand[];
  /** Warnings collected during traversal (e.g. unresolved optional deps). */
  warnings: string[];
}

/** An npm lockfile v3 package entry (subset used by ws-deploy). */
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
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  [key: string]: unknown;
}

/** An npm lockfile v3 document (subset used by ws-deploy). */
export interface NpmLockfile {
  name?: string;
  version?: string;
  lockfileVersion: number;
  requires?: boolean;
  packages: Record<string, LockfilePackageEntry>;
  [key: string]: unknown;
}

/** Strategy for producing the deployment install. */
export type InstallMode = "npm-install" | "npm-ci" | "none";

/** Install strategy used when callers do not specify one. */
export const DEFAULT_INSTALL_MODE: InstallMode = "npm-ci";

/** Options controlling a ws-deploy run. */
export interface DeployOptions {
  repositoryDir: string;
  targetWorkspace: string;
  deploymentDir: string;
  installMode?: InstallMode;
  /** npm configuration file used by the installation step. */
  npmrc?: string;
  includeDevDependencies?: boolean;
  includeOptionalDependencies?: boolean;
  /** Copy local packages into the deployment instead of installing them from their source paths. */
  copyLocalPackages?: boolean;
  /** When true, do not delete an existing deployment directory. */
  keepExistingDeploymentDir?: boolean;
}

/** Result of a completed ws-deploy run. */
export interface DeployResult {
  deploymentDir: string;
  closure: RuntimeClosure;
  lockfile: NpmLockfile;
  warnings: string[];
}
