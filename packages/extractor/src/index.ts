import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export interface ZipLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
  /** Max uncompressed/compressed ratio per entry (zip-bomb guard). */
  maxRatio: number;
}

export interface ZipEntryInfo {
  name: string;
  size: number;
  compressedSize: number;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface ZipInspection {
  entries: ZipEntryInfo[];
  totalBytes: number;
  /** Fatal problems: the archive must not be extracted. */
  problems: string[];
}

export interface ExtractResult {
  files: number;
  bytes: number;
  skipped: string[];
}

/** Returns a safe, normalised relative POSIX path, or null if the entry name is dangerous. */
export function normalizeEntryName(raw: string): string | null {
  if (raw.includes('\0')) return null;
  const name = raw.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

const isJunk = (n: string) => n.startsWith('__MACOSX/') || n.endsWith('/.DS_Store') || n === '.DS_Store';

function open(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (err, zf) =>
      err || !zf ? reject(err ?? new Error('cannot open zip')) : resolve(zf),
    );
  });
}

function forEachEntry(zf: yauzl.ZipFile, fn: (e: yauzl.Entry) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    zf.on('error', reject);
    zf.on('end', () => resolve());
    zf.on('entry', (e: yauzl.Entry) => {
      fn(e).then(
        () => zf.readEntry(),
        (err) => {
          zf.close();
          reject(err);
        },
      );
    });
    zf.readEntry();
  });
}

const entryIsSymlink = (e: yauzl.Entry) => ((e.externalFileAttributes >>> 16) & 0o170000) === 0o120000;

async function checkMagic(zipPath: string): Promise<string | null> {
  const fh = await fs.open(zipPath, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    const ok = buf[0] === 0x50 && buf[1] === 0x4b && [3, 5, 7].includes(buf[2] ?? -1);
    return ok ? null : 'File does not look like a ZIP archive (bad signature)';
  } finally {
    await fh.close();
  }
}

export async function inspectZip(zipPath: string, limits: ZipLimits): Promise<ZipInspection> {
  const problems: string[] = [];
  const magic = await checkMagic(zipPath);
  if (magic) return { entries: [], totalBytes: 0, problems: [magic] };

  const entries: ZipEntryInfo[] = [];
  let totalBytes = 0;
  try {
  const zf = await open(zipPath);
  await forEachEntry(zf, async (e) => {
    const isDirectory = e.fileName.endsWith('/');
    entries.push({
      name: e.fileName,
      size: e.uncompressedSize,
      compressedSize: e.compressedSize,
      isDirectory,
      isSymlink: entryIsSymlink(e),
    });
    totalBytes += e.uncompressedSize;
    if (entries.length > limits.maxEntries) throw new Error(`Archive has more than ${limits.maxEntries} entries`);
    if (isJunk(e.fileName)) return;
    if (normalizeEntryName(e.fileName) === null) problems.push(`Unsafe entry path: ${JSON.stringify(e.fileName)}`);
    if (e.isEncrypted()) problems.push(`Encrypted entry: ${e.fileName}`);
    if (
      e.compressedSize > 0 &&
      e.uncompressedSize > 1024 * 1024 &&
      e.uncompressedSize / e.compressedSize > limits.maxRatio
    ) {
      problems.push(`Suspicious compression ratio (possible zip bomb): ${e.fileName}`);
    }
  });
  } catch (e) {
    problems.push(`Invalid archive: ${(e as Error).message}`);
  }
  if (totalBytes > limits.maxUncompressedBytes) {
    problems.push(`Uncompressed size ${totalBytes} exceeds limit ${limits.maxUncompressedBytes}`);
  }
  if (entries.length === 0) problems.push('Archive is empty');
  return { entries, totalBytes, problems };
}

/**
 * Extract a ZIP into `destDir` (must be a new/empty directory). Rejects path traversal, skips symlinks,
 * and enforces the real (not declared) uncompressed byte limit while streaming.
 */
export async function safeExtract(zipPath: string, destDir: string, limits: ZipLimits): Promise<ExtractResult> {
  const root = path.resolve(destDir);
  await fs.mkdir(root, { recursive: true });
  const zf = await open(zipPath);
  const result: ExtractResult = { files: 0, bytes: 0, skipped: [] };

  await forEachEntry(zf, async (e) => {
    if (isJunk(e.fileName)) return;
    const rel = normalizeEntryName(e.fileName);
    if (rel === null) throw new Error(`Unsafe entry path: ${JSON.stringify(e.fileName)}`);
    if (rel === '') return;
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Path escapes target: ${e.fileName}`);

    if (e.fileName.endsWith('/')) {
      await fs.mkdir(target, { recursive: true });
      return;
    }
    if (entryIsSymlink(e)) {
      result.skipped.push(`${rel} (symlink)`);
      return;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
      zf.openReadStream(e, (err, s) => (err || !s ? reject(err ?? new Error('read failed')) : resolve(s))),
    );
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        result.bytes += chunk.length;
        if (result.bytes > limits.maxUncompressedBytes) return cb(new Error('Uncompressed size limit exceeded'));
        cb(null, chunk);
      },
    });
    await pipeline(stream, counter, createWriteStream(target, { flags: 'wx' }));
    result.files++;
  });
  return result;
}
