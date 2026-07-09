/** Minimal ambient declaration for `@npmcli/map-workspaces` (ships no types). */
declare module "@npmcli/map-workspaces" {
  interface MapWorkspacesOptions {
    /** Repo root the `workspaces` patterns are resolved against. */
    cwd?: string;
    /** Parsed root `package.json` containing the `workspaces` field. */
    pkg: object;
  }

  /** Resolve the `workspaces` field into a `name -> absolute path` map. */
  function mapWorkspaces(opts: MapWorkspacesOptions): Promise<Map<string, string>>;
  export default mapWorkspaces;
}
