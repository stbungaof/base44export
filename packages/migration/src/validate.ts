import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { exists, toPosix, walk } from '@b44/shared';
import type { MigrationContext } from './context';

const run = promisify(execFile);

export interface ValidationResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

/** Static validation of the generated project; optionally runs the frontend build. */
export async function validateOutput(ctx: MigrationContext, opts: { build: boolean }): Promise<ValidationResult> {
  const checks: ValidationResult['checks'] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail });
    ctx.log(ok ? 'info' : 'error', `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  };

  for (const f of ['Dockerfile', 'docker-compose.yml', '.env.example', 'server/package.json', 'server/src/server.mjs', 'server/src/storage.mjs', 'server/schema.sql', 'server/entities.json', 'original']) {
    check(`exists: ${f}`, await exists(path.join(ctx.projectDir, f)));
  }

  for (const f of ['server/src/server.mjs', 'server/src/storage.mjs']) {
    try {
      await run(process.execPath, ['--check', path.join(ctx.projectDir, f)]);
      check(`syntax: ${f}`, true);
    } catch (e) {
      check(`syntax: ${f}`, false, String((e as Error).message).split('\n')[0]);
    }
  }

  try {
    JSON.parse(await fs.readFile(path.join(ctx.serverDir, 'entities.json'), 'utf8'));
    const sql = await fs.readFile(path.join(ctx.serverDir, 'schema.sql'), 'utf8');
    check('schema.sql contains a table per entity', ctx.entityTables.every((t) => sql.includes(`CREATE TABLE IF NOT EXISTS "${t.table}"`)));
  } catch (e) {
    check('entities.json parses', false, (e as Error).message);
  }

  // residual SDK references in converted app
  let residual = 0;
  for await (const abs of walk(ctx.appDir)) {
    if (!/\.(jsx?|tsx?|mjs|cjs|vue|svelte)$/.test(abs)) continue;
    const rel = toPosix(path.relative(ctx.appDir, abs));
    if (rel.startsWith('functions/') || (ctx.shimPath && rel.startsWith(ctx.shimPath + '/'))) continue;
    const text = await fs.readFile(abs, 'utf8');
    if (text.includes("'@base44/sdk'") || text.includes('"@base44/sdk"')) {
      residual++;
      ctx.addFinding({ severity: 'manual', category: 'source', message: 'Unconverted @base44/sdk reference remains.', file: rel });
    }
  }
  ctx.log(residual ? 'warn' : 'info', `${residual} unconverted @base44/sdk reference(s) remain in app/`);

  if (opts.build && ctx.frontendConvertible && ctx.analysis.framework !== 'static-html') {
    const ok = await runBuild(ctx);
    check('frontend build (npm install && npm run build)', ok);
  } else {
    ctx.log('info', 'Frontend build skipped (set VALIDATE_BUILD=true to enable)');
    ctx.facts['frontend build'] = 'not run';
  }

  const ok = checks.every((c) => c.ok);
  ctx.facts['static validation'] = ok ? 'passed' : 'FAILED';
  return { ok, checks };
}

function runBuild(ctx: MigrationContext): Promise<boolean> {
  return new Promise((resolve) => {
    // Fixed command line, no user-controlled text; cwd is passed separately.
    const child = spawn('npm install --no-audit --no-fund && npm run build', { cwd: ctx.appDir, shell: true });
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.stdout.on('data', (d) => ctx.log('debug', String(d).trimEnd()));
    child.stderr.on('data', (d) => ctx.log('debug', String(d).trimEnd()));
    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.facts['frontend build'] = code === 0 ? 'passed' : `failed (exit ${code})`;
      resolve(code === 0);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
