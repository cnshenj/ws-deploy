/** Public entry points for ws-deploy (used by the CLI). */

export * from "./types.js";
export { runWsDeploy } from "./deploy.js";
export { loadWorkspaceGraph, resolveTargetWorkspace } from "./workspace-graph.js";
export { computeRuntimeClosure } from "./closure.js";
export { projectLockfile } from "./lockfile-projector.js";
export { materialize } from "./materializer.js";
export type { InstallerAdapter } from "./installer.js";
