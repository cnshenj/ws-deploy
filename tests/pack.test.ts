import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { runWsDeploy } from "../src/pack.js";
import type { PackageJson } from "../src/types.js";
import { buildFixtureRepo, cleanupFixture } from "./fixture.js";

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

describe("runWsPack (installMode none)", () => {
  let repo: string;
  let deployDir: string;

  before(async () => {
    repo = await buildFixtureRepo();
    deployDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-pack-output-"));
    await fs.rm(deployDir, { recursive: true, force: true });
  });

  after(async () => {
    await cleanupFixture(repo);
    await fs.rm(deployDir, { recursive: true, force: true });
  });

  it("materializes the deployment tree, rewrites manifests, and projects the lockfile", async () => {
    const result = await runWsDeploy({
      repoRoot: repo,
      targetWorkspace: "foo",
      deployDir: deployDir,
      installMode: "none",
    });

    // Root manifest: local deps rewritten, registry untouched, dev/workspaces removed.
    const rootManifest = await readJson<PackageJson>(path.join(deployDir, "package.json"));
    assert.equal(rootManifest.dependencies?.["lib"], "file:./local-packages/lib");
    assert.equal(rootManifest.dependencies?.["shared"], "file:./local-packages/shared");
    assert.equal(rootManifest.dependencies?.["somelib"], "^1.0.0");
    assert.equal(rootManifest.devDependencies, undefined);
    assert.equal(rootManifest.workspaces, undefined);

    // Local deps copied.
    assert.ok(
      await fs.stat(path.join(deployDir, "local-packages/lib/package.json")).then(() => true),
    );
    assert.ok(
      await fs.stat(path.join(deployDir, "local-packages/shared/package.json")).then(() => true),
    );

    // bar must not leak into the deployment (AC7).
    await assert.rejects(fs.stat(path.join(deployDir, "local-packages/bar")));

    // Filtered lockfile preserves exact versions; lodash@3 hoists to the root
    // (its monorepo nesting under somelib was only forced by bar's lodash@4,
    // which is not part of foo's closure).
    const lockfile = result.lockfile;
    assert.equal(lockfile.packages["node_modules/somelib"]?.version, "1.2.0");
    assert.equal(lockfile.packages["node_modules/lodash"]?.version, "3.10.1");
    assert.equal(lockfile.packages["node_modules/somelib/node_modules/lodash"], undefined);
    assert.equal(lockfile.packages["node_modules/leftpad"]?.version, "1.3.0");
    assert.equal(lockfile.packages["node_modules/lib"]?.link, true);
    assert.equal(lockfile.packages["node_modules/lib"]?.resolved, "local-packages/lib");
    // The unrelated lodash@4 (bar's) is excluded.
    assert.notEqual(lockfile.packages["node_modules/lodash"]?.version, "4.17.21");
  });
});
