/** Minimal ambient declaration for `npm-packlist` (ships no types). */
declare module "npm-packlist" {
  interface PacklistTree {
    /** Absolute path to the package directory to walk. */
    path: string;
    /** Parsed `package.json` for the package. */
    package: object;
    /**
     * Treat this package as the project root so npm-packlist does not attempt
     * to bundle dependencies (which would require an Arborist tree).
     */
    isProjectRoot?: boolean;
  }

  /** Return the list of files (relative, forward-slash) npm would pack. */
  function packlist(tree: PacklistTree): Promise<string[]>;
  export default packlist;
}
