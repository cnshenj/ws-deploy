import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { createArchive } from "../src/archive.js";
import { runWsPack } from "../src/pack.js";
import type { PackageJson } from "../src/types.js";
import { buildFixtureRepo, cleanupFixture } from "./fixture.js";

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

describe("runWsPack (installMode none)", () => {
  let repo: string;
  let stagingDir: string;

  before(async () => {
    repo = await buildFixtureRepo();
    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-pack-staging-"));
    await fs.rm(stagingDir, { recursive: true, force: true });
  });

  after(async () => {
    await cleanupFixture(repo);
    await fs.rm(stagingDir, { recursive: true, force: true });
  });

  it("materializes the staging tree, rewrites manifests, and projects the lockfile", async () => {
    const result = await runWsPack({
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

    // Filtered lockfile preserves exact versions and nesting.
    const lockfile = result.lockfile;
    assert.equal(lockfile.packages["node_modules/somelib"]?.version, "1.2.0");
    assert.equal(lockfile.packages["node_modules/somelib/node_modules/lodash"]?.version, "3.10.1");
    assert.equal(lockfile.packages["node_modules/leftpad"]?.version, "1.3.0");
    assert.equal(lockfile.packages["node_modules/lib"]?.link, true);
    assert.equal(lockfile.packages["node_modules/lib"]?.resolved, "_staging_deps/lib");
    // Unrelated lodash@4 omitted.
    assert.equal(lockfile.packages["node_modules/lodash"], undefined);
  });
});

describe("createArchive", () => {
  let repo: string;
  let stagingDir: string;

  before(async () => {
    repo = await buildFixtureRepo();
    stagingDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ws-pack-arc-")), "out");
    await runWsPack({
      repoRoot: repo,
      targetWorkspace: "foo",
      stagingDir,
      installMode: "none",
    });
  });

  after(async () => {
    await cleanupFixture(repo);
    await fs.rm(path.dirname(stagingDir), { recursive: true, force: true });
  });

  it("writes a zip with the PK signature", async () => {
    const out = path.join(path.dirname(stagingDir), "foo.zip");
    await createArchive(stagingDir, "zip", out);
    const buf = await fs.readFile(out);
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
    assert.ok(buf.length > 22);
  });

  it("writes a gzip-framed tgz", async () => {
    const out = path.join(path.dirname(stagingDir), "foo.tgz");
    await createArchive(stagingDir, "tgz", out);
    const buf = await fs.readFile(out);
    assert.equal(buf[0], 0x1f);
    assert.equal(buf[1], 0x8b);
  });
});
