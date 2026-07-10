/** Test-only helper that materializes a small monorepo fixture on disk. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
}

/**
 * Build a fixture monorepo:
 *
 *   root
 *   ├─ packages/foo   -> workspace:lib, file:../../shared, registry:somelib, dev:typescript
 *   ├─ packages/bar   -> registry:lodash@4 (unrelated)
 *   ├─ packages/lib   -> registry:leftpad
 *   └─ shared         -> (no deps, referenced via file:)
 *
 * Root lockfile pins somelib@1.2.0 (needs lodash@3.10.1 nested) and leftpad@1.3.0.
 * Returns the absolute repo root path.
 */
export async function buildFixtureRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ws-deploy-fixture-"));

  await writeJson(path.join(root, "package.json"), {
    name: "monorepo-root",
    version: "0.0.0",
    private: true,
    workspaces: ["packages/*"],
  });

  await writeJson(path.join(root, "packages/foo/package.json"), {
    name: "foo",
    version: "1.0.0",
    dependencies: {
      lib: "workspace:*",
      shared: "file:../../shared",
      somelib: "^1.0.0",
    },
    devDependencies: { typescript: "^5.0.0" },
  });
  await fs.writeFile(path.join(root, "packages/foo/index.js"), "export const foo = 1;\n");

  await writeJson(path.join(root, "packages/bar/package.json"), {
    name: "bar",
    version: "1.0.0",
    dependencies: { lodash: "^4.0.0" },
  });

  await writeJson(path.join(root, "packages/lib/package.json"), {
    name: "lib",
    version: "2.0.0",
    dependencies: { leftpad: "^1.0.0" },
  });
  await fs.writeFile(path.join(root, "packages/lib/index.js"), "export const lib = 1;\n");

  await writeJson(path.join(root, "shared/package.json"), {
    name: "shared",
    version: "3.0.0",
  });
  await fs.writeFile(path.join(root, "shared/index.js"), "export const shared = 1;\n");

  await writeJson(path.join(root, "package-lock.json"), {
    name: "monorepo-root",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "monorepo-root", version: "0.0.0" },
      "packages/foo": { name: "foo", version: "1.0.0" },
      "packages/bar": { name: "bar", version: "1.0.0" },
      "packages/lib": { name: "lib", version: "2.0.0" },
      "node_modules/foo": { resolved: "packages/foo", link: true },
      "node_modules/bar": { resolved: "packages/bar", link: true },
      "node_modules/lib": { resolved: "packages/lib", link: true },
      "node_modules/somelib": {
        version: "1.2.0",
        resolved: "https://registry.npmjs.org/somelib/-/somelib-1.2.0.tgz",
        integrity: "sha512-somelib",
        dependencies: { lodash: "^3.0.0" },
      },
      "node_modules/somelib/node_modules/lodash": {
        version: "3.10.1",
        resolved: "https://registry.npmjs.org/lodash/-/lodash-3.10.1.tgz",
        integrity: "sha512-lodash3",
      },
      "node_modules/lodash": {
        version: "4.17.21",
        resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
        integrity: "sha512-lodash4",
      },
      "node_modules/leftpad": {
        version: "1.3.0",
        resolved: "https://registry.npmjs.org/leftpad/-/leftpad-1.3.0.tgz",
        integrity: "sha512-leftpad",
      },
    },
  });

  return root;
}

/** Remove a fixture repo. */
export async function cleanupFixture(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}
