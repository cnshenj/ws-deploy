/** Builds the runtime dependency closure of the target workspace (SPEC §7.3 / FR6). */

import * as path from "node:path";

import type {
  ClosureRegistryPackage,
  DependencyEdge,
  NpmLockfile,
  DeployOptions,
  RegistryDemand,
  RuntimeClosure,
  DeployLocalDependency,
  WorkspaceGraph,
  WorkspaceNode,
} from "./types.js";
import { classifyDependency, classifyManifest } from "./dependency-classifier.js";
import { readManifest } from "./filesystem.js";
import { resolveLockfileEntry } from "./lockfile.js";

const LOCAL_PACKAGES_DIR = "local-packages";

interface ClosureContext {
  graph: WorkspaceGraph;
  lockfile: NpmLockfile;
  includeOptional: boolean;
  registryPackages: Map<string, ClosureRegistryPackage>;
  localDependencies: Map<string, DeployLocalDependency>;
  topDemands: RegistryDemand[];
  visitedLocal: Set<string>;
  warnings: string[];
}

/** Convert an absolute path to a forward-slash lockfile key relative to the repository. */
function toLockfileKey(repositoryDir: string, absPath: string): string {
  const rel = path.relative(repositoryDir, absPath).replace(/\\/g, "/");
  return rel;
}

/** Resolve a `file:`/`link:` specifier to an absolute path. */
function resolveFileSpecifier(fromDir: string, specifier: string): string {
  const target = specifier.replace(/^(file:|link:)/, "");
  return path.resolve(fromDir, target);
}

/** Runtime edges of a node: prod deps, plus optional deps when enabled. */
function runtimeEdges(node: WorkspaceNode, includeOptional: boolean): DependencyEdge[] {
  return includeOptional ? [...node.dependencies, ...node.optionalDependencies] : node.dependencies;
}

/**
 * Compute the runtime closure starting from the target workspace.
 */
export async function computeRuntimeClosure(
  graph: WorkspaceGraph,
  lockfile: NpmLockfile,
  target: WorkspaceNode,
  options: Pick<DeployOptions, "includeDevDependencies" | "includeOptionalDependencies">,
): Promise<RuntimeClosure> {
  const ctx: ClosureContext = {
    graph,
    lockfile,
    includeOptional: options.includeOptionalDependencies ?? false,
    registryPackages: new Map(),
    localDependencies: new Map(),
    topDemands: [],
    visitedLocal: new Set(),
    warnings: [],
  };

  const targetKey = toLockfileKey(graph.repositoryDir, target.path);
  const edges = runtimeEdges(target, ctx.includeOptional);
  if (options.includeDevDependencies) {
    edges.push(...target.devDependencies);
  }

  for (const edge of edges) {
    // eslint-disable-next-line no-await-in-loop -- traversal order is intentional
    const instanceKey = await traverseEdge(ctx, edge, target.path, targetKey);
    if (instanceKey) {
      ctx.topDemands.push({ location: "", instanceKey });
    }
  }

  return {
    target,
    localDependencies: ctx.localDependencies,
    registryPackages: ctx.registryPackages,
    topDemands: ctx.topDemands,
    warnings: ctx.warnings,
  };
}

async function traverseEdge(
  ctx: ClosureContext,
  edge: DependencyEdge,
  fromDir: string,
  fromKey: string,
): Promise<string | undefined> {
  switch (edge.kind) {
    case "workspace":
      await traverseWorkspace(ctx, edge);
      return undefined;
    case "file":
      await traverseFile(ctx, edge, fromDir);
      return undefined;
    case "registry":
      return traverseRegistry(ctx, edge.depName, fromKey, edge.group === "optional");
    case "dev":
      return traverseEdge(
        ctx,
        { ...edge, kind: classifyDependency(edge.depName, edge.specifier, workspaceNameSet(ctx)) },
        fromDir,
        fromKey,
      );
    default:
      return undefined; // peer dependencies are not traversed
  }
}

async function traverseWorkspace(ctx: ClosureContext, edge: DependencyEdge): Promise<void> {
  const node = ctx.graph.nodes.get(edge.depName);
  if (!node) {
    throw new Error(
      `Workspace dependency "${edge.depName}" (required by "${edge.fromPackage}") ` +
        `could not be resolved to a workspace package.`,
    );
  }
  await addLocalDependency(ctx, {
    name: node.name,
    sourceType: "workspace",
    sourcePath: node.path,
    version: node.version,
    manifest: node.manifest,
  });
}

async function traverseFile(
  ctx: ClosureContext,
  edge: DependencyEdge,
  fromDir: string,
): Promise<void> {
  const resolvedPath = resolveFileSpecifier(fromDir, edge.specifier);
  let manifest;
  try {
    manifest = await readManifest(path.join(resolvedPath, "package.json"));
  } catch {
    throw new Error(
      `File dependency "${edge.specifier}" (required by "${edge.fromPackage}") ` +
        `does not resolve to a package with a package.json at ${resolvedPath}.`,
    );
  }
  const name = manifest.name ?? edge.depName;
  await addLocalDependency(ctx, {
    name,
    sourceType: "file",
    sourcePath: resolvedPath,
    version: manifest.version ?? "0.0.0",
    manifest,
  });
}

interface LocalInput {
  name: string;
  sourceType: DeployLocalDependency["sourceType"];
  sourcePath: string;
  version: string;
  manifest: DeployLocalDependency["manifest"];
}

async function addLocalDependency(ctx: ClosureContext, input: LocalInput): Promise<void> {
  if (ctx.visitedLocal.has(input.name)) {
    return;
  }
  ctx.visitedLocal.add(input.name);

  const deploymentRelativePath = `${LOCAL_PACKAGES_DIR}/${input.name}`;
  ctx.localDependencies.set(input.name, {
    name: input.name,
    sourceType: input.sourceType,
    sourcePath: input.sourcePath,
    version: input.version,
    manifest: input.manifest,
    deploymentRelativePath,
    deploymentReference: `file:./${deploymentRelativePath}`,
  });

  // Recurse into the local dependency's own runtime edges (EC2, EC3).
  const classified = classifyManifest(input.name, input.manifest, workspaceNameSet(ctx));
  const edges = ctx.includeOptional
    ? [...classified.dependencies, ...classified.optionalDependencies]
    : classified.dependencies;
  const fromKey = toLockfileKey(ctx.graph.repositoryDir, input.sourcePath);
  for (const edge of edges) {
    // eslint-disable-next-line no-await-in-loop -- traversal order is intentional
    const instanceKey = await traverseEdge(ctx, edge, input.sourcePath, fromKey);
    if (instanceKey) {
      ctx.topDemands.push({ location: deploymentRelativePath, instanceKey });
    }
  }
}

function workspaceNameSet(ctx: ClosureContext): ReadonlySet<string> {
  return new Set(ctx.graph.nodes.keys());
}

function traverseRegistry(
  ctx: ClosureContext,
  depName: string,
  fromKey: string,
  optional: boolean,
): string | undefined {
  const resolved = resolveLockfileEntry(ctx.lockfile, fromKey, depName);
  if (!resolved) {
    if (optional) {
      // A missing optional dependency is legitimate (e.g. platform-specific
      // packages absent from the lockfile for this platform); omit it.
      ctx.warnings.push(
        `Optional registry dependency "${depName}" (from "${fromKey || "<repository>"}") was not ` +
          `found in the repository lockfile; it will be omitted from the filtered lockfile.`,
      );
      return undefined;
    }
    // A required runtime dependency with no lockfile entry means the repository
    // lockfile is out of sync with the manifests. Omitting it would ship a
    // broken artifact, so fail loudly (SPEC §3.1, §11.1).
    throw new Error(
      `Runtime dependency "${depName}" (required by "${fromKey || "<repository>"}") is reachable at ` +
        `runtime but has no entry in the repository lockfile. package-lock.json is out of sync ` +
        `with the workspace manifests; run "npm install" in the repository directory to refresh ` +
        `it, then retry.`,
    );
  }
  const { key, entry } = resolved;
  const version = entry.version ?? "0.0.0";
  const instanceKey = `${depName}@${version}`;
  if (ctx.registryPackages.has(instanceKey)) {
    return instanceKey;
  }

  const node: ClosureRegistryPackage = {
    name: depName,
    version,
    lockfileKey: key,
    dependencies: [],
    peerDependencies: [],
  };
  ctx.registryPackages.set(instanceKey, node);

  // Recurse into required transitive registry dependencies. Optionality is
  // sticky: the whole subtree under an optional dependency is itself optional.
  for (const childName of Object.keys(entry.dependencies ?? {})) {
    const childKey = traverseRegistry(ctx, childName, key, optional);
    if (childKey) {
      node.dependencies.push(childKey);
    }
  }
  if (ctx.includeOptional) {
    for (const childName of Object.keys(entry.optionalDependencies ?? {})) {
      if (entry.dependencies && childName in entry.dependencies) {
        continue; // already traversed as a required child
      }
      const childKey = traverseRegistry(ctx, childName, key, true);
      if (childKey) {
        node.dependencies.push(childKey);
      }
    }
  }
  // npm installs peers by default and requires their resolved entries to be
  // present in a lockfile consumed by `npm ci`.
  for (const peerName of Object.keys(entry.peerDependencies ?? {})) {
    const peerKey = traverseRegistry(
      ctx,
      peerName,
      key,
      entry.peerDependenciesMeta?.[peerName]?.optional === true,
    );
    if (peerKey) {
      node.peerDependencies.push(peerKey);
    }
  }
  return instanceKey;
}
