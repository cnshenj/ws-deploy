import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { computeRuntimeClosure } from "../src/closure.js";
import { loadRootLockfile } from "../src/lockfile.js";
import { buildFixtureRepo, cleanupFixture } from "./fixture.js";
import { loadWorkspaceGraph, resolveTargetWorkspace } from "../src/workspace-graph.js";

describe("computeRuntimeClosure", () => {
  let repo: string;

  before(async () => {
    repo = await buildFixtureRepo();
  });

  after(async () => {
    await cleanupFixture(repo);
  });

  it("includes workspace, file, and transitive registry deps but excludes unrelated ones", async () => {
    const graph = await loadWorkspaceGraph(repo);
    const target = resolveTargetWorkspace(graph, "foo");
    const lockfile = await loadRootLockfile(repo);

    const closure = await computeRuntimeClosure(graph, lockfile, target, {});

    // Local deps: lib (workspace) and shared (file).
    assert.deepEqual([...closure.localDependencies.keys()].toSorted(), ["lib", "shared"]);
    assert.equal(closure.localDependencies.get("lib")?.sourceType, "workspace");
    assert.equal(closure.localDependencies.get("shared")?.sourceType, "file");
    assert.equal(
      closure.localDependencies.get("lib")?.stagingReference,
      "file:./_staging_deps/lib",
    );

    // Registry deps: somelib, its nested lodash@3, and lib's leftpad.
    const registry = [...closure.registryPackages.values()]
      .map((p) => `${p.name}@${p.version}`)
      .toSorted();
    assert.deepEqual(registry, ["leftpad@1.3.0", "lodash@3.10.1", "somelib@1.2.0"]);

    // Unrelated workspace bar and its lodash@4 must be absent (AC1, AC7).
    assert.ok(!closure.localDependencies.has("bar"));
    assert.ok(!registry.includes("lodash@4.17.21"));
  });

  it("fails clearly for a missing target workspace", async () => {
    const graph = await loadWorkspaceGraph(repo);
    assert.throws(() => resolveTargetWorkspace(graph, "does-not-exist"), /not found/);
  });
});
