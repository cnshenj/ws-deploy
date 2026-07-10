import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { runWsDeploy } from "../src/deploy.js";
import type { PackageJson } from "../src/types.js";
import { buildFixtureRepo, cleanupFixture } from "./fixture.js";

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

describe("runWsDeploy (installMode none)", () => {
  let repo: string;
  let stagingDir: string;

  before(async () => {
    repo = await buildFixtureRepo();
    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-deploy-staging-"));
    await fs.rm(stagingDir, { recursive: true, force: true });
  });

  after(async () => {
    await cleanupFixture(repo);
    await fs.rm(stagingDir, { recursive: true, force: true });
  });

  it("materializes the staging tree, rewrites manifests, and projects the lockfile", async () => {
    const result = await runWsDeploy({
      repoRoot: repo,
      targetWorkspace: "foo",
      stagingDir,
      installMode: "none",
    });

    // Root manifest: local deps rewritten, registry untouched, dev/workspaces removed.
    const rootManifest = await readJson<PackageJson>(path.join(stagingDir, "package.json"));
    assert.equal(rootManifest.dependencies?.["lib"], "file:./_staging_deps/lib");
    assert.equal(rootManifest.dependencies?.["shared"], "file:./_staging_deps/shared");
    assert.equal(rootManifest.dependencies?.["somelib"], "^1.0.0");
    assert.equal(rootManifest.devDependencies, undefined);
    assert.equal(rootManifest.workspaces, undefined);

    // Local deps copied.
    assert.ok(
      await fs.stat(path.join(stagingDir, "_staging_deps/lib/package.json")).then(() => true),
    );
    assert.ok(
      await fs.stat(path.join(stagingDir, "_staging_deps/shared/package.json")).then(() => true),
    );

    // bar must not leak into staging (AC7).
    await assert.rejects(fs.stat(path.join(stagingDir, "_staging_deps/bar")));

    // Filtered lockfile preserves exact versions; lodash@3 hoists to the root
    // (its monorepo nesting under somelib was only forced by bar's lodash@4,
    // which is not part of foo's closure).
    const lockfile = result.lockfile;
    assert.equal(lockfile.packages["node_modules/somelib"]?.version, "1.2.0");
    assert.equal(lockfile.packages["node_modules/lodash"]?.version, "3.10.1");
    assert.equal(lockfile.packages["node_modules/somelib/node_modules/lodash"], undefined);
    assert.equal(lockfile.packages["node_modules/leftpad"]?.version, "1.3.0");
    assert.equal(lockfile.packages["node_modules/lib"]?.link, true);
    assert.equal(lockfile.packages["node_modules/lib"]?.resolved, "_staging_deps/lib");
    // The unrelated lodash@4 (bar's) is excluded.
    assert.notEqual(lockfile.packages["node_modules/lodash"]?.version, "4.17.21");
  });
});
