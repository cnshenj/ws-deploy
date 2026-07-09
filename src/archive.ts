/** Dependency-free archive writers for the staging folder (SPEC §7 / FR10, Step 10). */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";

import type { ArchiveFormat } from "./types.js";

interface FileEntry {
  /** Archive-relative path using forward slashes. */
  relPath: string;
  absPath: string;
  size: number;
}

/** Recursively collect files under `root` (forward-slash relative paths). */
async function collectFiles(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        out.push({ relPath: rel, absPath: abs, size: stat.size });
      }
    }
  }
  await walk(root, "");
  return out.toSorted((a, b) => a.relPath.localeCompare(b.relPath));
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
  const buffer = format === "zip" ? await buildZip(files) : await buildTgz(files);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buffer);
  return outPath;
}

/* ------------------------------- tar / tgz ------------------------------- */

const BLOCK = 512;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0");
}

function tarHeader(name: string, size: number, typeflag: string): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name.slice(0, 100), 0, "utf8");
  header.write("0000644", 100, "ascii"); // mode
  header.write("0000000", 108, "ascii"); // uid
  header.write("0000000", 116, "ascii"); // gid
  header.write(octal(size, 12), 124, "ascii"); // size
  header.write(octal(0, 12), 136, "ascii"); // mtime (fixed for determinism)
  header.write("        ", 148, "ascii"); // checksum placeholder (8 spaces)
  header.write(typeflag, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += header[i] as number;
  }
  header.write(`${octal(sum, 7)}\0 `, 148, "ascii");
  return header;
}

function pad512(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

async function buildTgz(files: FileEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const nameBytes = Buffer.from(file.relPath, "utf8");
    if (nameBytes.length > 100) {
      // GNU long name extension.
      const longHeader = tarHeader("././@LongLink", nameBytes.length + 1, "L");
      chunks.push(longHeader);
      const nameBlock = Buffer.concat([nameBytes, Buffer.from([0])]);
      chunks.push(nameBlock, Buffer.alloc(pad512(nameBlock.length), 0));
    }
    const data = await fs.readFile(file.absPath);
    chunks.push(tarHeader(file.relPath, data.length, "0"));
    chunks.push(data, Buffer.alloc(pad512(data.length), 0));
  }
  // Two trailing zero blocks.
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  const tar = Buffer.concat(chunks);
  return zlib.gzipSync(tar);
}

/* ---------------------------------- zip ---------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    const index = (crc ^ (buffer[i] as number)) & 0xff;
    crc = (crc >>> 8) ^ (CRC_TABLE[index] as number);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function buildZip(files: FileEntry[]): Promise<Buffer> {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.relPath, "utf8");
    const data = await fs.readFile(file.absPath);
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const method = useDeflate ? 8 : 0;
    const stored = useDeflate ? compressed : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + stored.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const centralOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}
