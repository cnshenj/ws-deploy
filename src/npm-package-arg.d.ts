/** Minimal ambient declaration for `npm-package-arg` (ships no types). */
declare module "npm-package-arg" {
  function npa(arg: string, where?: string): npa.Result;
  namespace npa {
    interface Result {
      /** e.g. `version`, `range`, `tag`, `file`, `directory`, `git`, `remote`, `alias`. */
      type: string;
      /** True when the spec resolves against a registry. */
      registry?: boolean;
    }

    /** Resolve a `name` + `spec` pair. Throws on unsupported protocols. */
    function resolve(name: string, spec: string, where?: string): Result;
  }
  export = npa;
}
