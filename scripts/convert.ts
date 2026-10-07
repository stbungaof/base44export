// CLI: run the full pipeline on a ZIP without PostgreSQL or the API.
//   npm run convert -- path/to/export.zip [outputDataDir]
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runPipeline } from '@b44/core';
import { loadConfig } from '@b44/shared';

const [zip, dataDir = './data'] = process.argv.slice(2);
if (!zip) {
  console.error('usage: npm run convert -- <export.zip> [dataDir]');
  process.exit(2);
}
const config = loadConfig({ ...process.env, DATA_DIR: dataDir });
const jobId = randomUUID();
await fs.mkdir(config.dirs.uploads, { recursive: true });
await fs.copyFile(zip, path.join(config.dirs.uploads, `${jobId}.zip`));

const result = await runPipeline({
  jobId,
  zipPath: path.join(config.dirs.uploads, `${jobId}.zip`),
  originalName: path.basename(zip),
  config,
  recorder: {
    stageStart: (s) => console.log(`\n== ${s}`),
    stageEnd: (s, st, e) => console.log(`== ${s}: ${st}${e ? ` (${e})` : ''}`),
    log: (_s, l, m) => console.log(`  [${l}] ${m}`),
    save: () => {},
  },
});
console.log(`\n${result.status.toUpperCase()}  project: ${result.projectDir}\n         zip: ${result.zipPath}`);
process.exit(result.status === 'succeeded' ? 0 : 1);
