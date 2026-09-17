import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyDependency } from "../src/dependency-classifier.js";

describe("classifyDependency", () => {
  const workspaces = new Set(["lib", "shared"]);

  it("classifies the workspace protocol", () => {
    assert.equal(classifyDependency("anything", "workspace:*", workspaces), "workspace");
    assert.equal(classifyDependency("x", "workspace:^1.2.3", workspaces), "workspace");
  });

  it("classifies file and link protocols", () => {
    assert.equal(classifyDependency("x", "file:../lib", workspaces), "file");
    assert.equal(classifyDependency("x", "link:../lib", workspaces), "file");
  });

  it("classifies name matches against the workspace set", () => {
    assert.equal(classifyDependency("lib", "^2.0.0", workspaces), "workspace");
    assert.equal(classifyDependency("shared", "3.0.0", workspaces), "workspace");
  });

  it("keeps explicit external sources when the name matches a workspace", () => {
    for (const specifier of [
      "npm:other-lib@^2.0.0",
      "github:owner/lib#v2.0.0",
      "https://registry.npmjs.org/lib/-/lib-2.0.0.tgz",
    ]) {
      assert.equal(classifyDependency("lib", specifier, workspaces), "registry", specifier);
    }
  });

  it("classifies everything else as registry", () => {
    assert.equal(classifyDependency("lodash", "^4.0.0", workspaces), "registry");
    assert.equal(classifyDependency("somelib", "1.2.0", workspaces), "registry");
  });
});
