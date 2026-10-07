import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import path from 'node:path';

/** Build a ZIP from an in-memory file map. Names are used verbatim. */
export async function makeZip(outFile: string, files: Record<string, string>): Promise<string> {
  const out = createWriteStream(outFile);
  const archive = archiver('zip');
  const closed = new Promise<void>((res, rej) => (out.on('close', res), archive.on('error', rej)));
  archive.pipe(out);
  for (const [name, content] of Object.entries(files)) archive.append(content, { name });
  await archive.finalize();
  await closed;
  return path.resolve(outFile);
}

export const BASE44_FIXTURE: Record<string, string> = {
  'my-app/package.json': JSON.stringify({
    name: 'my-app',
    dependencies: { react: '^18', '@base44/sdk': '^0.1.0' },
    devDependencies: { vite: '^5' },
  }),
  'my-app/index.html': '<div id="root"></div>',
  'my-app/src/api/base44Client.js': "import { createClient } from '@base44/sdk';\nexport const base44 = createClient({ appId: 'abc' });\n",
  'my-app/src/api/entities.js': "import { base44 } from './base44Client';\nexport const Task = base44.entities.Task;\nexport const Ghost = base44.entities.Ghost;\n",
  'my-app/src/pages/Home.jsx':
    "import { base44 } from '@/api/base44Client';\nconst me = await base44.auth.me();\nawait base44.integrations.Core.UploadFile({ file });\nawait base44.integrations.Core.InvokeLLM({ prompt: 'x' });\nconst logo = 'https://files.base44.app/x/logo.png';\n",
  'my-app/entities/Task.json': JSON.stringify({
    name: 'Task',
    type: 'object',
    properties: {
      title: { type: 'string' },
      done: { type: 'boolean', default: false },
      priority: { type: 'string', enum: ['low', 'high'] },
      due: { type: 'string', format: 'date' },
      tags: { type: 'array' },
      'bad name': { type: 'string' },
    },
    required: ['title'],
  }),
};

/** Minimal "stored" ZIP writer that keeps entry names verbatim (archiver sanitises `../`). */
export async function makeRawZip(outFile: string, files: Record<string, string>): Promise<string> {
  const { crc32 } = await import('node:zlib');
  const fs = await import('node:fs/promises');
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const n = Buffer.from(name);
    const d = Buffer.from(content);
    const crc = crc32(d);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, d);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  await fs.writeFile(outFile, Buffer.concat([...locals, cd, eocd]));
  return outFile;
}
