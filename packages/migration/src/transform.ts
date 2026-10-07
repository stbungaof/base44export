import fs from 'node:fs/promises';
import path from 'node:path';
import { copyTree, exists, parseJsonc, toPosix, walk } from '@b44/shared';
import type { MigrationContext } from './context';
import { SHIM_DTS, SHIM_JS } from './templates/shim';

const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte']);
const SDK_IMPORT = /((?:from\s+|import\s*\(?\s*|require\(\s*))(['"])@base44\/sdk\2/g;
const SDK_SUBPATH = /(?:from\s+|import\s*\(?\s*|require\(\s*)['"]@base44\/sdk\/[^'"]+['"]/;
const VITE_CONFIGS = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.mts'];

/**
 * Preserve the original source, then build a working copy in project/app with the Base44 SDK import
 * replaced by a local compatibility layer and the Base44 Vite plugin removed. Only exact
 * `@base44/sdk` specifiers and the `@base44/vite-plugin` default import are rewritten.
 */
export async function transformSource(ctx: MigrationContext): Promise<void> {
  await copyTree(ctx.sourceRoot, ctx.originalDir);
  await copyTree(ctx.sourceRoot, ctx.appDir);
  ctx.log('info', 'Original source preserved at project/original');

  const removeDeps: string[] = [];
  const usesSdk = ctx.analysis.base44.sdkImports.length > 0 || '@base44/sdk' in ctx.analysis.base44.packages;
  if (usesSdk) {
    await installShim(ctx);
    removeDeps.push('@base44/sdk');
  } else {
    ctx.log('info', 'No @base44/sdk usage found; no source rewrite needed');
  }

  if (await rewriteViteConfig(ctx)) removeDeps.push('@base44/vite-plugin');
  if (removeDeps.length) await removeDependencies(ctx, removeDeps);
}

async function installShim(ctx: MigrationContext): Promise<void> {
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
}

/** Index of the `)` matching the `(` at `open`, skipping strings and comments; -1 if unbalanced. */
function findClosingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

async function hasAtAlias(ctx: MigrationContext): Promise<boolean> {
  for (const name of ['jsconfig.json', 'tsconfig.json', 'tsconfig.app.json']) {
    const f = path.join(ctx.appDir, name);
    if (!(await exists(f))) continue;
    try {
      const cfg = parseJsonc(await fs.readFile(f, 'utf8')) as any;
      if (cfg?.compilerOptions?.paths?.['@/*']) return true;
    } catch {
      /* ignore unreadable config */
    }
  }
  return false;
}

/**
 * Remove `import x from '@base44/vite-plugin'` and the `x({...})` plugin call. The plugin appears to be what
 * resolves the `@/` import alias (vite.config has no alias of its own), so add an explicit one when the
 * project's jsconfig/tsconfig maps `@/*`. Returns true if the plugin was removed.
 */
async function rewriteViteConfig(ctx: MigrationContext): Promise<boolean> {
  for (const name of VITE_CONFIGS) {
    const file = path.join(ctx.appDir, name);
    if (!(await exists(file))) continue;
    let text = await fs.readFile(file, 'utf8');
    if (!text.includes('@base44/vite-plugin')) return false;

    const manual = (message: string) => ctx.addFinding({ severity: 'manual', category: 'source', message, file: name });
    const imp = /^[ \t]*import\s+(\w+)\s+from\s+['"]@base44\/vite-plugin['"];?[ \t]*\r?\n/m.exec(text);
    if (!imp) {
      manual('Could not recognise the @base44/vite-plugin import; remove the plugin from the Vite config manually.');
      return false;
    }
    const ident = imp[1]!;
    text = text.replace(imp[0], '');
    const call = new RegExp(`\\b${ident}\\s*\\(`).exec(text);
    const close = call ? findClosingParen(text, call.index + call[0].length - 1) : -1;
    if (!call || close < 0) {
      manual('Could not locate the Base44 plugin call in the Vite config; remove it manually.');
      return false;
    }
    let start = call.index;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (/^[ \t]*$/.test(text.slice(lineStart, start))) start = lineStart;
    const tail = /^[ \t]*,?[ \t]*\r?\n?/.exec(text.slice(close + 1))![0];
    text = text.slice(0, start) + text.slice(close + 1 + tail.length);

    let detail = 'removed @base44/vite-plugin';
    if ((await hasAtAlias(ctx)) && !/\balias\b/.test(text)) {
      if (/defineConfig\(\{/.test(text)) {
        text = text.replace(/defineConfig\(\{/, "defineConfig({\n  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },");
        text = "import { fileURLToPath } from 'node:url';\n" + text;
        detail += " and added the '@' -> ./src alias";
      } else {
        manual("Removed the Base44 Vite plugin but could not add the '@' import alias; add resolve.alias to the Vite config manually.");
      }
    }
    await fs.writeFile(file, text);
    ctx.changes.push({ file: `app/${name}`, kind: 'rewrite-import', detail });
    ctx.log('info', `${name}: ${detail}`);
    return true;
  }
  return false;
}

async function removeDependencies(ctx: MigrationContext, names: string[]): Promise<void> {
  const file = path.join(ctx.appDir, 'package.json');
  if (!(await exists(file))) return;
  let pkg: any;
  try {
    pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    ctx.addFinding({ severity: 'manual', category: 'dependencies', message: `package.json is not valid JSON; ${names.join(', ')} left in place.`, file: 'package.json' });
    return;
  }
  const removed: string[] = [];
  for (const key of ['dependencies', 'devDependencies'] as const) {
    for (const n of names) {
      if (pkg[key]?.[n]) {
        delete pkg[key][n];
        removed.push(n);
      }
    }
  }
  if (removed.length) {
    await fs.writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
    ctx.changes.push({ file: 'app/package.json', kind: 'edit-package-json', detail: `removed ${[...new Set(removed)].join(', ')}` });
  }
}
