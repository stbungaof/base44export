import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPipeline } from '@b44/core';
import { loadConfig } from '@b44/shared';
import { BASE44_FIXTURE, makeZip } from './helpers';

let tmp: string;
beforeAll(async () => void (tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'b44-pipe-'))));
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

async function convert(files: Record<string, string>, id: string) {
  const config = loadConfig({ DATA_DIR: path.join(tmp, id) });
  await fs.mkdir(config.dirs.uploads, { recursive: true });
  const zipPath = path.join(config.dirs.uploads, `${id}.zip`);
  await makeZip(zipPath, files);
  const logs: string[] = [];
  const result = await runPipeline({
    jobId: id,
    zipPath,
    originalName: 'export.zip',
    config,
    recorder: { stageStart() {}, stageEnd() {}, log: (_s, l, m) => void logs.push(`${l} ${m}`), save() {} },
  });
  return { result, config, logs };
}

describe('pipeline on a Base44-style export', () => {
  it('converts the project and reports what it cannot convert', async () => {
    const { result, logs } = await convert(BASE44_FIXTURE, 'job1');
    expect(result.stages.filter((s) => s.status !== 'succeeded'), logs.join('\n')).toEqual([]);
    const p = result.projectDir;

    // database
    const sql = await fs.readFile(path.join(p, 'server/schema.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "task"');
    expect(sql).toContain('"title" text NOT NULL');
    expect(sql).toContain('"done" boolean DEFAULT false');
    expect(sql).toContain('"due" date');
    expect(sql).toContain('"tags" jsonb');
    expect(sql).toContain("IN ('low', 'high')");
    expect(sql).not.toContain('bad name');

    // source: original preserved verbatim, app rewritten
    const orig = await fs.readFile(path.join(p, 'original/src/api/base44Client.js'), 'utf8');
    expect(orig).toContain("from '@base44/sdk'");
    const conv = await fs.readFile(path.join(p, 'app/src/api/base44Client.js'), 'utf8');
    expect(conv).toContain("from '../lib/local-base44/index.js'");
    expect(conv).not.toContain('@base44/sdk');
    const pkg = JSON.parse(await fs.readFile(path.join(p, 'app/package.json'), 'utf8'));
    expect(pkg.dependencies['@base44/sdk']).toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(p, 'original/package.json'), 'utf8')).dependencies['@base44/sdk']).toBeDefined();

    // config + packaging + report
    for (const f of ['Dockerfile', 'docker-compose.yml', '.env.example', 'server/src/server.mjs', 'MIGRATION_REPORT.md']) {
      await fs.access(path.join(p, f));
    }
    expect((await fs.stat(result.zipPath)).size).toBeGreaterThan(0);

    const report = JSON.parse(await fs.readFile(path.join(p, 'MIGRATION_REPORT.json'), 'utf8'));
    const manual = report.findings.filter((f: any) => f.severity === 'manual').map((f: any) => f.message);
    expect(manual.some((m: string) => m.includes('"Ghost"'))).toBe(true); // used but no schema
    expect(manual.some((m: string) => m.includes('InvokeLLM'))).toBe(true);
    expect(manual.some((m: string) => m.includes('Base44-hosted URL'))).toBe(true);
    expect(report.detection.framework).toBe('vite-react');
  });

  it('fails cleanly on garbage input and skips later stages', async () => {
    const config = loadConfig({ DATA_DIR: path.join(tmp, 'bad') });
    await fs.mkdir(config.dirs.uploads, { recursive: true });
    const zipPath = path.join(config.dirs.uploads, 'bad.zip');
    await fs.writeFile(zipPath, 'nope');
    const result = await runPipeline({
      jobId: 'bad',
      zipPath,
      originalName: 'bad.zip',
      config,
      recorder: { stageStart() {}, stageEnd() {}, log() {}, save() {} },
    });
    expect(result.status).toBe('failed');
    expect(result.stages.find((s) => s.name === 'VALIDATE')?.status).toBe('failed');
    expect(result.stages.find((s) => s.name === 'EXTRACT')?.status).toBe('skipped');
  });

  it('reads entity schemas from base44/entities/*.jsonc and does not flag its own shim', async () => {
    const files = {
      'app/package.json': JSON.stringify({ name: 'a', dependencies: { vite: '5', react: '18', '@base44/sdk': '1' } }),
      'app/src/api/base44Client.js': "import { createClient } from '@base44/sdk';\nexport const base44 = createClient({});\n",
      'app/src/p.jsx': 'const c = await base44.entities.Customer.list();',
      'app/AGENTS.md': 'see https://app.base44.com/docs',
      'app/base44/entities/Customer.jsonc':
        '// a customer\n{\n  "name": "Customer", /* block */\n  "type": "object",\n  "properties": { "name": { "type": "string", "description": "a // not a comment" }, },\n  "required": ["name"],\n}\n',
    };
    const { result, logs } = await convert(files, 'jsonc');
    expect(result.stages.filter((s) => s.status !== 'succeeded'), logs.join('\n')).toEqual([]);
    const report = JSON.parse(await fs.readFile(path.join(result.projectDir, 'MIGRATION_REPORT.json'), 'utf8'));
    expect(report.detection.entities).toEqual(['Customer']);
    expect(await fs.readFile(path.join(result.projectDir, 'server/schema.sql'), 'utf8')).toContain('CREATE TABLE IF NOT EXISTS "customer"');
    const msgs = report.findings.map((f: any) => f.message).join('\n');
    expect(msgs).not.toContain('Unconverted @base44/sdk');
    expect(msgs).not.toContain('Base44-hosted URL');
    expect(report.job.stages.find((s: any) => s.name === 'REPORT').status).toBe('succeeded');
  });

  it('handles a project with no Base44 usage and no entities', async () => {
    const { result } = await convert({ 'x/package.json': '{"name":"x","dependencies":{"vite":"5"}}', 'x/index.html': '<p/>' }, 'plain');
    expect(result.status).toBe('succeeded');
  });
});
