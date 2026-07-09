import { defineConfig } from "oxfmt";

/**
 * Oxfmt configuration (typed via `defineConfig`).
 * Run with: `npx oxfmt -c oxfmt.config.mts src tests`
 *
 * Values mirror the existing source style: double quotes, semicolons,
 * 2-space indent, and trailing commas.
 */
export default defineConfig({
  printWidth: 100,
  tabWidth: 2,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  ignorePatterns: ["out/**", "node_modules/**"],
});
