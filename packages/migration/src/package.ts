import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Zip a directory (contents at archive root under `prefix`). Overwrites any existing archive. */
export async function zipDirectory(srcDir: string, outFile: string, prefix = 'self-hosted-project'): Promise<number> {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.rm(outFile, { force: true });
  const out = createWriteStream(outFile);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const done = new Promise<void>((resolve, reject) => {
    out.on('close', resolve);
    out.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(out);
  archive.directory(srcDir, prefix);
  await archive.finalize();
  await done;
  return (await fs.stat(outFile)).size;
}
