import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { runWsDeploy } from "../src/deploy.js";
import type { NpmLockfile } from "../src/types.js";

/** Write a JSON file, creating parent directories. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
}

/** Materialize a temp monorepo from a set of manifests + a root lockfile. */
async function buildRepo(
  manifests: Record<string, unknown>,
  lockfile: NpmLockfile,
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ws-deploy-hoist-"));
  for (const [dir, manifest] of Object.entries(manifests)) {
    await writeJson(path.join(root, dir, "package.json"), manifest);
    await fs.writeFile(path.join(root, dir, "index.js"), "export default 1;\n", "utf8");
  }
  await writeJson(path.join(root, "package-lock.json"), lockfile);
  return root;
}

async function deploy(root: string, target: string): Promise<NpmLockfile> {
  const stagingDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ws-deploy-out-")), "out");
  const result = await runWsDeploy({
    repoRoot: root,
    targetWorkspace: target,
    stagingDir,
    installMode: "none",
  });
  return result.lockfile;
}

describe("projectLockfile hoisting", () => {
  const cleanups: string[] = [];
  after(async () => {
    for (const dir of cleanups) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("nests a conflicting version under the consumer that needs it", async () => {
    // foo needs somelib@1 (nested under foo in the monorepo); lib needs
    // somelib@2 (hoisted to root). Re-rooted on foo: somelib@1 rises to the
    // root, somelib@2 must nest under lib.
    const root = await buildRepo(
      {
        ".": { name: "root", private: true, workspaces: ["packages/*"] },
        "packages/foo": {
          name: "foo",
          version: "1.0.0",
          dependencies: { lib: "workspace:*", somelib: "^1.0.0" },
        },
        "packages/lib": { name: "lib", version: "1.0.0", dependencies: { somelib: "^2.0.0" } },
      },
      {
        name: "root",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "root" },
          "packages/foo": { name: "foo", version: "1.0.0" },
          "packages/lib": { name: "lib", version: "1.0.0" },
          "node_modules/foo": { resolved: "packages/foo", link: true },
          "node_modules/lib": { resolved: "packages/lib", link: true },
          "node_modules/somelib": {
            version: "2.0.0",
            resolved: "https://r/s-2.0.0.tgz",
            integrity: "sha512-v2",
          },
          "packages/foo/node_modules/somelib": {
            version: "1.0.0",
            resolved: "https://r/s-1.0.0.tgz",
            integrity: "sha512-v1",
          },
        },
      },
    );
    cleanups.push(root);

    const lockfile = await deploy(root, "foo");

    assert.equal(lockfile.packages["node_modules/somelib"]?.version, "1.0.0");
    assert.equal(lockfile.packages["_staging_deps/lib/node_modules/somelib"]?.version, "2.0.0");
    assert.equal(lockfile.packages["node_modules/lib"]?.link, true);
  });

  it("hoists the most-used version to the root and nests the minority", async () => {
    // p1/p2/p3 need lodash@4, q needs lodash@3. In the monorepo, lodash@3 is at
    // the root and lodash@4 is nested under each p. Re-rooted on foo, the
    // most-used version (lodash@4, 3 consumers) hoists to the root; lodash@3
    // (1 consumer) nests under q — inverting the monorepo layout.
    const root = await buildRepo(
      {
        ".": { name: "root", private: true, workspaces: ["packages/*"] },
        "packages/foo": {
          name: "foo",
          version: "1.0.0",
          dependencies: {
            p1: "workspace:*",
            p2: "workspace:*",
            p3: "workspace:*",
            q: "workspace:*",
          },
        },
        "packages/p1": { name: "p1", version: "1.0.0", dependencies: { lodash: "^4.0.0" } },
        "packages/p2": { name: "p2", version: "1.0.0", dependencies: { lodash: "^4.0.0" } },
        "packages/p3": { name: "p3", version: "1.0.0", dependencies: { lodash: "^4.0.0" } },
        "packages/q": { name: "q", version: "1.0.0", dependencies: { lodash: "^3.0.0" } },
      },
      {
        name: "root",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "root" },
          "packages/foo": { name: "foo", version: "1.0.0" },
          "packages/p1": { name: "p1", version: "1.0.0" },
          "packages/p2": { name: "p2", version: "1.0.0" },
          "packages/p3": { name: "p3", version: "1.0.0" },
          "packages/q": { name: "q", version: "1.0.0" },
          "node_modules/foo": { resolved: "packages/foo", link: true },
          "node_modules/p1": { resolved: "packages/p1", link: true },
          "node_modules/p2": { resolved: "packages/p2", link: true },
          "node_modules/p3": { resolved: "packages/p3", link: true },
          "node_modules/q": { resolved: "packages/q", link: true },
          "node_modules/lodash": {
            version: "3.0.0",
            resolved: "https://r/l-3.0.0.tgz",
            integrity: "sha512-l3",
          },
          "packages/p1/node_modules/lodash": {
            version: "4.0.0",
            resolved: "https://r/l-4.0.0.tgz",
            integrity: "sha512-l4",
          },
          "packages/p2/node_modules/lodash": {
            version: "4.0.0",
            resolved: "https://r/l-4.0.0.tgz",
            integrity: "sha512-l4",
          },
          "packages/p3/node_modules/lodash": {
            version: "4.0.0",
            resolved: "https://r/l-4.0.0.tgz",
            integrity: "sha512-l4",
          },
        },
      },
    );
    cleanups.push(root);

    const lockfile = await deploy(root, "foo");

    // Majority version at the root.
    assert.equal(lockfile.packages["node_modules/lodash"]?.version, "4.0.0");
    // Minority nested under its lone consumer.
    assert.equal(lockfile.packages["_staging_deps/q/node_modules/lodash"]?.version, "3.0.0");
    // The three majority consumers share the root copy (no per-consumer nesting).
    assert.equal(lockfile.packages["_staging_deps/p1/node_modules/lodash"], undefined);
    assert.equal(lockfile.packages["_staging_deps/p2/node_modules/lodash"], undefined);
    assert.equal(lockfile.packages["_staging_deps/p3/node_modules/lodash"], undefined);
  });
});
