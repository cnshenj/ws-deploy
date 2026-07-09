/** Archive writers for the staging folder (SPEC §7 / FR10, Step 10). */

import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { create as tarCreate } from "tar";
import { ZipFile } from "yazl";

import type { ArchiveFormat } from "./types.js";

/** Fixed timestamp so archives are byte-reproducible (SPEC NFR1). */
const EPOCH = new Date(0);

/** Collect files under `root` as sorted forward-slash relative paths. */
async function collectFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const abs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    files.push(rel);
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

/**
 * Create an archive of the staging folder.
 * Returns the archive path, or undefined when `format` is `none`.
 */
export async function createArchive(
  stagingDir: string,
  format: ArchiveFormat,
  outPath: string,
): Promise<string | undefined> {
  if (format === "none") {
    return undefined;
  }
  const files = await collectFiles(stagingDir);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  if (format === "zip") {
    await buildZip(stagingDir, files, outPath);
  } else {
    await buildTgz(stagingDir, files, outPath);
  }
  return outPath;
}

/** Write a gzip-compressed tar via the `tar` library (deterministic headers). */
async function buildTgz(stagingDir: string, files: string[], outPath: string): Promise<void> {
  await tarCreate(
    { gzip: true, file: outPath, cwd: stagingDir, portable: true, mtime: EPOCH },
    files,
  );
}

/** Write a zip archive via `yazl` with fixed timestamps for reproducibility. */
async function buildZip(stagingDir: string, files: string[], outPath: string): Promise<void> {
  const zip = new ZipFile();
  for (const rel of files) {
    zip.addFile(path.join(stagingDir, rel), rel, { mtime: EPOCH, mode: 0o100644 });
  }
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outPath);
    output.on("error", reject);
    output.on("close", resolve);
    zip.outputStream.on("error", reject).pipe(output);
    zip.end();
  });
}
