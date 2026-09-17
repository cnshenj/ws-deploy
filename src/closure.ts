/** Builds the runtime dependency closure of the target workspace (SPEC §7.3 / FR6). */

import { createHash } from "node:crypto";
import * as path from "node:path";

import npa from "npm-package-arg";

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
import { pathExists, readManifest } from "./filesystem.js";
import { resolveLockfileEntry } from "./lockfile.js";

const LOCAL_PACKAGES_DIR = "local-packages";

interface ClosureContext {
  graph: WorkspaceGraph;
  lockfile: NpmLockfile;
  includeOptional: boolean;
  registryPackages: Map<string, ClosureRegistryPackage>;
  registryResolutions: Map<string, string>;
  localDependencies: Map<string, DeployLocalDependency>;
  localResolutions: Map<string, Map<string, string>>;
  topDemands: RegistryDemand[];
  visitedLocal: Set<string>;
  warnings: string[];
}

/** Convert an absolute path to a forward-slash lockfile key relative to the repository. */
function toLockfileKey(repositoryDir: string, absPath: string): string {
  const rel = path.relative(repositoryDir, absPath).replace(/\\/g, "/");
  return rel;
}

/** Runtime edges of a node: prod deps, plus optional deps when enabled. */
function runtimeEdges(node: WorkspaceNode, includeOptional: boolean): DependencyEdge[] {
  return includeOptional
    ? [...node.dependencies, ...node.optionalDependencies]
    : [...node.dependencies];
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
    registryResolutions: new Map(),
    localDependencies: new Map(),
    localResolutions: new Map(),
    topDemands: [],
    visitedLocal: new Set(),
    warnings: [],
  };

  const targetKey = toLockfileKey(graph.repositoryDir, target.path);
  const edges = runtimeEdges(target, ctx.includeOptional);
  edges.push(
    ...target.peerDependencies.filter(
      (edge) => target.manifest.peerDependenciesMeta?.[edge.depName]?.optional !== true,
    ),
  );
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

  deduplicateRegistryPackages(ctx);

  return {
    target,
    includeOptionalDependencies: ctx.includeOptional,
    localDependencies: ctx.localDependencies,
    localResolutions: ctx.localResolutions,
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
    case "workspace": {
      const resolved = resolveLockfileEntry(ctx.lockfile, fromKey, edge.depName);
      if (!edge.specifier.startsWith("workspace:") && resolved && !resolved.entry.link) {
        return traverseRegistry(ctx, edge.depName, fromKey, edge.group === "optional");
      }
      await traverseWorkspace(ctx, edge);
      if (ctx.localDependencies.has(edge.depName)) {
        recordLocalResolution(ctx, fromDir, edge.depName);
      }
      return undefined;
    }
    case "file": {
      const instanceKey = await traverseFile(ctx, edge, fromDir, fromKey);
      if (ctx.localDependencies.has(edge.depName)) {
        recordLocalResolution(ctx, fromDir, edge.depName);
      }
      return instanceKey;
    }
    case "registry":
      return traverseRegistry(ctx, edge.depName, fromKey, edge.group === "optional");
    case "peer":
      return traverseEdge(
        ctx,
        { ...edge, kind: classifyDependency(edge.depName, edge.specifier, workspaceNameSet(ctx)) },
        fromDir,
        fromKey,
      );
    case "dev":
      return traverseEdge(
        ctx,
        { ...edge, kind: classifyDependency(edge.depName, edge.specifier, workspaceNameSet(ctx)) },
        fromDir,
        fromKey,
      );
  }
}

function recordLocalResolution(ctx: ClosureContext, fromDir: string, depName: string): void {
  let resolutions = ctx.localResolutions.get(fromDir);
  if (!resolutions) {
    resolutions = new Map();
    ctx.localResolutions.set(fromDir, resolutions);
  }
  resolutions.set(depName, depName);
}

async function traverseWorkspace(ctx: ClosureContext, edge: DependencyEdge): Promise<void> {
  const node = ctx.graph.nodes.get(edge.depName);
  if (!node) {
    if (edge.group === "optional") {
      ctx.warnings.push(
        `Optional workspace dependency "${edge.depName}" could not be resolved; it will be omitted.`,
      );
      return;
    }
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
    optional: edge.group === "optional",
  });
}

async function traverseFile(
  ctx: ClosureContext,
  edge: DependencyEdge,
  fromDir: string,
  fromKey: string,
): Promise<string | undefined> {
  const parsed = npa.resolve(edge.depName, edge.specifier.replace(/^link:/, "file:"), fromDir);
  const resolvedPath = parsed.fetchSpec!;
  if (parsed.type === "file") {
    if (!(await pathExists(resolvedPath))) {
      if (edge.group === "optional") {
        ctx.warnings.push(
          `Optional local tarball dependency "${edge.depName}" was not found; it will be omitted.`,
        );
        return undefined;
      }
      throw new Error(
        `Local tarball dependency "${edge.depName}" was not found at ${resolvedPath}.`,
      );
    }
    return traverseRegistry(ctx, edge.depName, fromKey, edge.group === "optional");
  }
  let manifest;
  try {
    manifest = await readManifest(path.join(resolvedPath, "package.json"));
  } catch (error) {
    if (
      edge.group === "optional" &&
      ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      ctx.warnings.push(
        `Optional file dependency "${edge.depName}" was not found; it will be omitted.`,
      );
      return undefined;
    }
    throw new Error(
      `File dependency "${edge.specifier}" (required by "${edge.fromPackage}") ` +
        `does not resolve to a package with a package.json at ${resolvedPath}.`,
      { cause: error },
    );
  }
  const resolved = resolveLockfileEntry(ctx.lockfile, fromKey, edge.depName);
  await addLocalDependency(ctx, {
    name: edge.depName,
    sourceType: "file",
    sourcePath: resolvedPath,
    version: manifest.version ?? "0.0.0",
    manifest,
    lockfileKey: resolved && !resolved.entry.link ? resolved.key : undefined,
    optional: edge.group === "optional",
  });
  return undefined;
}

interface LocalInput {
  name: string;
  sourceType: DeployLocalDependency["sourceType"];
  sourcePath: string;
  version: string;
  manifest: DeployLocalDependency["manifest"];
  lockfileKey?: string;
  optional?: boolean;
}

async function addLocalDependency(ctx: ClosureContext, input: LocalInput): Promise<void> {
  const existing = ctx.localDependencies.get(input.name);
  if (existing && path.relative(existing.sourcePath, input.sourcePath) !== "") {
    throw new Error(
      `Local dependency "${input.name}" resolves to both "${existing.sourcePath}" and "${input.sourcePath}". ` +
        `Distinct local sources under the same dependency name are not supported; use different dependency aliases.`,
    );
  }
  if (ctx.visitedLocal.has(input.name) && !(existing?.optional && !input.optional)) {
    return;
  }
  ctx.visitedLocal.add(input.name);

  const deploymentRelativePath = `${LOCAL_PACKAGES_DIR}/${input.name}`;
  ctx.localDependencies.set(input.name, {
    name: input.name,
    optional: input.optional,
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
  edges.push(
    ...classified.peerDependencies.filter(
      (edge) => input.manifest.peerDependenciesMeta?.[edge.depName]?.optional !== true,
    ),
  );
  const fromKey = input.lockfileKey ?? toLockfileKey(ctx.graph.repositoryDir, input.sourcePath);
  for (const edge of edges) {
    // eslint-disable-next-line no-await-in-loop -- traversal order is intentional
    const instanceKey = await traverseEdge(
      ctx,
      input.optional ? { ...edge, group: "optional" } : edge,
      input.sourcePath,
      fromKey,
    );
    if (instanceKey) {
      ctx.topDemands.push({ location: deploymentRelativePath, instanceKey });
    }
  }
}

function workspaceNameSet(ctx: ClosureContext): ReadonlySet<string> {
  return new Set(ctx.graph.nodes.keys());
}

async function traverseRegistry(
  ctx: ClosureContext,
  depName: string,
  fromKey: string,
  optional: boolean,
): Promise<string | undefined> {
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
  if (entry.link && entry.resolved) {
    const sourcePath = path.resolve(ctx.graph.repositoryDir, entry.resolved);
    const workspace = [...ctx.graph.nodes.values()].find((node) => node.path === sourcePath);
    const manifest =
      workspace?.manifest ?? (await readManifest(path.join(sourcePath, "package.json")));
    await addLocalDependency(ctx, {
      name: depName,
      sourceType: workspace ? "workspace" : "file",
      sourcePath,
      version: manifest.version ?? "0.0.0",
      manifest,
      optional,
    });
    return undefined;
  }
  const version = entry.version ?? "0.0.0";
  const existing = ctx.registryResolutions.get(key);
  if (existing && (optional || !ctx.registryPackages.get(existing)?.optional)) {
    return existing;
  }
  const versionKey = `${depName}@${version}`;
  const instanceKey =
    existing ?? (ctx.registryPackages.has(versionKey) ? `${versionKey}#${key}` : versionKey);
  ctx.registryResolutions.set(key, instanceKey);

  const node: ClosureRegistryPackage = {
    name: depName,
    version,
    optional,
    lockfileKey: key,
    dependencies: [],
    peerDependencies: [],
  };
  if (entry.resolved?.startsWith("file:")) {
    const parsed = npa.resolve(depName, entry.resolved, ctx.graph.repositoryDir);
    if (parsed.type === "file") {
      node.localTarball = {
        sourcePath: parsed.fetchSpec!,
        deploymentRelativePath: `local-tarballs/${createHash("sha256").update(entry.resolved).digest("hex")}.tgz`,
      };
    }
  }
  ctx.registryPackages.set(instanceKey, node);

  // Recurse into required transitive registry dependencies. Optionality is
  // sticky: the whole subtree under an optional dependency is itself optional.
  for (const childName of Object.keys(entry.dependencies ?? {})) {
    if (entry.optionalDependencies?.[childName] !== undefined) {
      continue;
    }
    const childKey = await traverseRegistry(ctx, childName, key, optional);
    if (childKey) {
      node.dependencies.push(childKey);
    }
  }
  if (ctx.includeOptional) {
    for (const childName of Object.keys(entry.optionalDependencies ?? {})) {
      const childKey = await traverseRegistry(ctx, childName, key, true);
      if (childKey) {
        node.dependencies.push(childKey);
      }
    }
  }
  // npm installs peers by default and requires their resolved entries to be
  // present in a lockfile consumed by `npm ci`.
  for (const peerName of Object.keys(entry.peerDependencies ?? {})) {
    const peerKey = await traverseRegistry(
      ctx,
      peerName,
      key,
      optional || entry.peerDependenciesMeta?.[peerName]?.optional === true,
    );
    if (peerKey) {
      node.peerDependencies.push(peerKey);
    }
  }
  return instanceKey;
}

function deduplicateRegistryPackages(ctx: ClosureContext): void {
  const nodes = [...ctx.registryPackages.entries()];
  const partition = (
    signature: (key: string, node: ClosureRegistryPackage) => string,
  ): Map<string, number> => {
    const signatures = new Map<string, number>();
    return new Map(
      nodes.map(([key, node]) => {
        const value = signature(key, node);
        let group = signatures.get(value);
        if (group === undefined) {
          group = signatures.size;
          signatures.set(value, group);
        }
        return [key, group];
      }),
    );
  };
  let groups = partition((_key, node) =>
    JSON.stringify([
      node.name,
      node.optional,
      Object.entries(ctx.lockfile.packages[node.lockfileKey] ?? {}).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    ]),
  );
  for (;;) {
    const refined = partition((key, node) =>
      JSON.stringify([
        groups.get(key),
        node.dependencies.map((child) => groups.get(child)).toSorted(),
        node.peerDependencies.map((peer) => groups.get(peer)).toSorted(),
      ]),
    );
    if (nodes.every(([key]) => refined.get(key) === groups.get(key))) {
      break;
    }
    groups = refined;
  }

  const canonical = new Map<number, string>();
  for (const [key] of nodes) {
    const group = groups.get(key)!;
    if (!canonical.has(group)) {
      canonical.set(group, key);
    }
  }
  const canonicalKey = (key: string): string => canonical.get(groups.get(key)!)!;
  ctx.registryPackages.clear();
  for (const [key, node] of nodes) {
    if (canonicalKey(key) === key) {
      node.dependencies = [...new Set(node.dependencies.map(canonicalKey))];
      node.peerDependencies = [...new Set(node.peerDependencies.map(canonicalKey))];
      ctx.registryPackages.set(key, node);
    }
  }
  for (const demand of ctx.topDemands) {
    demand.instanceKey = canonicalKey(demand.instanceKey);
  }
}
