import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectZip, normalizeEntryName, safeExtract } from '@b44/extractor';
import { makeRawZip, makeZip } from './helpers';

const limits = { maxEntries: 100, maxUncompressedBytes: 10 * 1024 * 1024, maxRatio: 200 };
let tmp: string;
beforeAll(async () => void (tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'b44-ext-'))));
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

describe('normalizeEntryName', () => {
  it('accepts normal paths and rejects dangerous ones', () => {
    expect(normalizeEntryName('a/b.txt')).toBe('a/b.txt');
    expect(normalizeEntryName('a\\b.txt')).toBe('a/b.txt');
    expect(normalizeEntryName('../x')).toBeNull();
    expect(normalizeEntryName('a/../../x')).toBeNull();
    expect(normalizeEntryName('/etc/passwd')).toBeNull();
    expect(normalizeEntryName('C:\\x')).toBeNull();
  });
});

describe('zip handling', () => {
  it('extracts a valid archive', async () => {
    const zip = await makeZip(path.join(tmp, 'ok.zip'), { 'p/a.txt': 'hi', 'p/sub/b.txt': 'yo' });
    expect((await inspectZip(zip, limits)).problems).toEqual([]);
    const dest = path.join(tmp, 'ok');
    const r = await safeExtract(zip, dest, limits);
    expect(r.files).toBe(2);
    expect(await fs.readFile(path.join(dest, 'p/sub/b.txt'), 'utf8')).toBe('yo');
  });

  it('rejects path traversal and never writes outside the target', async () => {
    const zip = await makeRawZip(path.join(tmp, 'evil.zip'), { '../escape.txt': 'x', 'ok.txt': 'y' });
    const ins = await inspectZip(zip, limits);
    expect(ins.problems.join()).toMatch(/Unsafe entry path|invalid relative path/);
    await expect(safeExtract(zip, path.join(tmp, 'evil'), limits)).rejects.toThrow(/Unsafe|invalid relative path/);
    await expect(fs.access(path.join(tmp, 'escape.txt'))).rejects.toThrow();
  });

  it('rejects non-zip files', async () => {
    const f = path.join(tmp, 'fake.zip');
    await fs.writeFile(f, 'not a zip at all');
    expect((await inspectZip(f, limits)).problems[0]).toMatch(/ZIP/);
  });

  it('enforces the real uncompressed size limit', async () => {
    const zip = await makeZip(path.join(tmp, 'big.zip'), { 'a.txt': 'x'.repeat(5000) });
    await expect(safeExtract(zip, path.join(tmp, 'big'), { ...limits, maxUncompressedBytes: 1000 })).rejects.toThrow(/limit/);
  });
});
