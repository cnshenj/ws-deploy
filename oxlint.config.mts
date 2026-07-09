import { defineConfig } from "oxlint";

/**
 * Oxlint configuration (typed via `defineConfig`).
 * Run with: `npx oxlint -c oxlint.config.mts src tests`
 */
export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc", "import", "promise", "node"],
  categories: {
    correctness: "error",
    suspicious: "warn",
    perf: "warn",
  },
  rules: {
    // Sequential awaits are intentional here: traversal/materialization order
    // matters and unbounded parallel filesystem I/O is deliberately avoided.
    "no-await-in-loop": "off",
  },
  ignorePatterns: ["out/**", "node_modules/**"],
});
