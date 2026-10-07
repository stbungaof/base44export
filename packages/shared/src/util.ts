import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

export const toPosix = (p: string) => p.split(path.sep).join('/');

/** Entity / column names we are willing to put in SQL identifiers and URLs. */
export const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '__MACOSX']);

/** Copy a directory tree, skipping heavy/derived directories. Never touches the source. */
export async function copyTree(src: string, dst: string, skip: Set<string> = SKIP_DIRS): Promise<void> {
  await fs.cp(src, dst, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (s) => s === src || !skip.has(path.basename(s)),
  });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function* walk(dir: string, skip: Set<string> = SKIP_DIRS): AsyncGenerator<string> {
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    if (d.isDirectory()) {
      if (!skip.has(d.name)) yield* walk(path.join(dir, d.name), skip);
    } else if (d.isFile()) {
      yield path.join(dir, d.name);
    }
  }
}
