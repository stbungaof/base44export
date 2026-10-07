import fs from 'node:fs/promises';
import path from 'node:path';
import type { MigrationContext } from './context';
import { STORAGE_MJS } from './templates/server';

/** Generate the local-filesystem storage module and record remote-storage references that need re-hosting. */
export async function generateStorage(ctx: MigrationContext): Promise<void> {
  await fs.mkdir(path.join(ctx.serverDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(ctx.serverDir, 'src', 'storage.mjs'), STORAGE_MJS);
  ctx.changes.push({ file: 'server/src/storage.mjs', kind: 'add-file', detail: 'local upload storage (UPLOADS_DIR, default /data/uploads)' });

  const refs = ctx.analysis.base44.remoteStorageRefs;
  ctx.log('info', `${refs.length} hard-coded Base44-hosted URL(s) detected`);
  for (const r of refs.slice(0, 20)) ctx.log('warn', `remote URL ${r.file}:${r.line}  ${r.snippet}`);

  const usesUpload = Object.keys(ctx.analysis.base44.integrationUsage).includes('Core.UploadFile');
  ctx.log('info', usesUpload ? 'UploadFile usage detected: mapped to POST /api/files' : 'No UploadFile usage detected');
}
