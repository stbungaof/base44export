import fs from 'node:fs/promises';
import path from 'node:path';
import { copyTree, exists, toPosix, walk } from '@b44/shared';
import type { MigrationContext } from './context';
import { SHIM_DTS, SHIM_JS } from './templates/shim';

const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte']);
const SDK_IMPORT = /((?:from\s+|import\s*\(?\s*|require\(\s*))(['"])@base44\/sdk\2/g;
const SDK_SUBPATH = /(?:from\s+|import\s*\(?\s*|require\(\s*)['"]@base44\/sdk\/[^'"]+['"]/;

/**
 * Preserve the original source, then build a working copy in project/app with the Base44 SDK import
 * replaced by a local compatibility layer. Only exact `@base44/sdk` specifiers are rewritten.
 */
export async function transformSource(ctx: MigrationContext): Promise<void> {
  await copyTree(ctx.sourceRoot, ctx.originalDir);
  await copyTree(ctx.sourceRoot, ctx.appDir);
  ctx.log('info', 'Original source preserved at project/original');

  const usesSdk = ctx.analysis.base44.sdkImports.length > 0 || '@base44/sdk' in ctx.analysis.base44.packages;
  if (!usesSdk) {
    ctx.log('info', 'No @base44/sdk usage found; no source rewrite needed');
    return;
  }

  const srcDir = (await exists(path.join(ctx.appDir, 'src'))) ? path.join(ctx.appDir, 'src') : ctx.appDir;
  const shimDir = path.join(srcDir, 'lib', 'local-base44');
  await fs.mkdir(shimDir, { recursive: true });
  await fs.writeFile(path.join(shimDir, 'index.js'), SHIM_JS);
  await fs.writeFile(path.join(shimDir, 'index.d.ts'), SHIM_DTS);
  ctx.shimPath = toPosix(path.relative(ctx.appDir, shimDir));
  ctx.changes.push({ file: `app/${ctx.shimPath}/index.js`, kind: 'add-file', detail: 'local @base44/sdk compatibility layer' });

  let rewritten = 0;
  for await (const abs of walk(ctx.appDir)) {
    if (!CODE_EXT.has(path.extname(abs).toLowerCase()) || abs.startsWith(shimDir + path.sep)) continue;
    const rel = toPosix(path.relative(ctx.appDir, abs));
    if (rel.startsWith('functions/')) continue; // backend functions: reported, not touched
    const text = await fs.readFile(abs, 'utf8');
    if (!text.includes('@base44/')) continue;

    if (SDK_SUBPATH.test(text)) {
      ctx.addFinding({ severity: 'manual', category: 'source', message: 'Import of an @base44/sdk subpath cannot be converted automatically.', file: rel });
    }
    if (!SDK_IMPORT.test(text)) continue;
    SDK_IMPORT.lastIndex = 0;

    let spec = toPosix(path.relative(path.dirname(abs), shimDir));
    if (!spec.startsWith('.')) spec = './' + spec;
    const next = text.replace(SDK_IMPORT, (_m, pre: string, quote: string) => `${pre}${quote}${spec}/index.js${quote}`);
    await fs.writeFile(abs, next);
    rewritten++;
    ctx.changes.push({ file: `app/${rel}`, kind: 'rewrite-import', detail: `@base44/sdk -> ${spec}/index.js` });
  }
  ctx.log('info', `Rewrote @base44/sdk imports in ${rewritten} file(s)`);

  await rewritePackageJson(ctx);
}

async function rewritePackageJson(ctx: MigrationContext): Promise<void> {
  const file = path.join(ctx.appDir, 'package.json');
  if (!(await exists(file))) return;
  let pkg: any;
  try {
    pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    ctx.addFinding({ severity: 'manual', category: 'dependencies', message: 'package.json is not valid JSON; @base44/sdk dependency left in place.', file: 'package.json' });
    return;
  }
  let removed = false;
  for (const key of ['dependencies', 'devDependencies'] as const) {
    if (pkg[key]?.['@base44/sdk']) {
      delete pkg[key]['@base44/sdk'];
      removed = true;
    }
  }
  if (removed) {
    await fs.writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
    ctx.changes.push({ file: 'app/package.json', kind: 'edit-package-json', detail: 'removed @base44/sdk dependency' });
  }
}
