import fs from 'node:fs/promises';
import path from 'node:path';
import type { Analysis, EntityInfo, Hit } from '@b44/shared';
import { toPosix, walk } from '@b44/shared';

const TEXT_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.html', '.vue', '.svelte', '.env', '.md']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_HITS_PER_KEY = 50;

const RE = {
  sdkImport: /(?:from\s+|import\s*\(?\s*|require\(\s*)['"](@base44\/[\w\-./]+)['"]/g,
  entity: /\bbase44\.entities\.([A-Za-z_]\w*)/g,
  entityDynamic: /\bbase44\.entities\s*\[/g,
  auth: /\bbase44\.auth\.(\w+)/g,
  integration: /\bbase44\.integrations\.(\w+)\.(\w+)/g,
  integrationNamed:
    /\b(UploadFile|UploadPrivateFile|CreateFileSignedUrl|InvokeLLM|SendEmail|SendSMS|GenerateImage|ExtractDataFromUploadedFile)\b/g,
  other: /\bbase44\.(functions|agents|analytics|users|asServiceRole|appLogs|connectors)\b/g,
  remote: /https?:\/\/[^\s'"`)<>]*(?:base44\.(?:app|com)|base44-prod|files\.base44)[^\s'"`)<>]*/g,
  env: /\b(?:VITE_|REACT_APP_|NEXT_PUBLIC_)?BASE44_\w+/g,
};

function push(map: Record<string, Hit[]>, key: string, hit: Hit) {
  const list = (map[key] ??= []);
  if (list.length < MAX_HITS_PER_KEY) list.push(hit);
}

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Shallowest directory containing a package.json; falls back to the extraction root. */
async function findProjectRoot(dir: string): Promise<string> {
  let best: string | null = null;
  for await (const f of walk(dir)) {
    if (path.basename(f) !== 'package.json') continue;
    const rel = toPosix(path.relative(dir, path.dirname(f)));
    const depth = rel === '' ? 0 : rel.split('/').length;
    if (best === null || depth < (best === '' ? 0 : best.split('/').length)) best = rel;
    if (depth === 0) break;
  }
  return best ?? '';
}

function detectFramework(deps: Record<string, string>, files: Set<string>): { framework: string; buildDir: string | null } {
  const has = (n: string) => n in deps;
  if (has('next')) return { framework: 'next', buildDir: null };
  if (has('@remix-run/react') || has('@remix-run/node')) return { framework: 'remix', buildDir: null };
  if (has('nuxt')) return { framework: 'nuxt', buildDir: null };
  if (has('@sveltejs/kit')) return { framework: 'sveltekit', buildDir: null };
  if (has('vite')) {
    const ui = has('react') ? 'react' : has('vue') ? 'vue' : has('svelte') ? 'svelte' : 'vanilla';
    return { framework: `vite-${ui}`, buildDir: 'dist' };
  }
  if (has('react-scripts')) return { framework: 'cra-react', buildDir: 'build' };
  if (has('express') || has('fastify')) return { framework: 'node-server', buildDir: null };
  if (files.has('index.html')) return { framework: 'static-html', buildDir: '.' };
  return { framework: 'unknown', buildDir: null };
}

/**
 * Inspect an extracted Base44 export. Everything reported here is derived from file contents;
 * nothing is assumed about the project layout.
 */
export async function analyze(extractDir: string): Promise<Analysis> {
  const projectRoot = await findProjectRoot(extractDir);
  const root = path.join(extractDir, projectRoot);
  const pkg = (await readJson(path.join(root, 'package.json'))) ?? {};
  const deps: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  const a: Analysis = {
    projectRoot,
    fileCount: 0,
    totalBytes: 0,
    framework: 'unknown',
    frontendBuildDir: null,
    packageManager: 'npm',
    packageName: typeof pkg.name === 'string' ? pkg.name : null,
    dependencies: deps,
    base44: {
      packages: Object.fromEntries(Object.entries(deps).filter(([n]) => n.startsWith('@base44/') || n.includes('base44'))),
      sdkImports: [],
      entityUsage: {},
      authUsage: {},
      integrationUsage: {},
      otherSdkUsage: {},
      remoteStorageRefs: [],
      envRefs: [],
      configFiles: [],
      backendFunctions: [],
      entities: [],
      unparsedEntityFiles: [],
    },
  };

  const topFiles = new Set<string>();
  const entityFiles: string[] = [];

  for await (const abs of walk(root)) {
    const rel = toPosix(path.relative(root, abs));
    const st = await fs.stat(abs);
    a.fileCount++;
    a.totalBytes += st.size;
    if (!rel.includes('/')) topFiles.add(rel);

    if (/^(\.base44|base44)(\/|\.)/.test(rel) || /(^|\/)base44\.config\./.test(rel)) a.base44.configFiles.push(rel);
    if (/^functions\//.test(rel)) a.base44.backendFunctions.push(rel);
    if (/(^|\/)entities\/[^/]+\.json$/i.test(rel) || /\.entity\.json$/i.test(rel)) entityFiles.push(rel);

    const base = path.basename(rel);
    if (base === 'pnpm-lock.yaml') a.packageManager = 'pnpm';
    else if (base === 'yarn.lock') a.packageManager = 'yarn';
    else if (base === 'bun.lockb' || base === 'bun.lock') a.packageManager = 'bun';

    if (!TEXT_EXT.has(path.extname(rel).toLowerCase()) && !base.startsWith('.env')) continue;
    if (st.size > MAX_FILE_BYTES) continue;
    const lines = (await fs.readFile(abs, 'utf8')).split(/\r?\n/);
    lines.forEach((text, i) => {
      if (text.length > 2000 || !/base44|UploadFile|InvokeLLM|SendEmail|GenerateImage|SendSMS|CreateFileSignedUrl|ExtractData/i.test(text)) return;
      const hit: Hit = { file: rel, line: i + 1, snippet: text.trim().slice(0, 200) };
      for (const m of text.matchAll(RE.sdkImport)) {
        if (a.base44.sdkImports.length < 200) a.base44.sdkImports.push({ ...hit, snippet: hit.snippet });
        a.base44.packages[m[1]!] ??= '(imported, not in package.json)';
      }
      for (const m of text.matchAll(RE.entity)) push(a.base44.entityUsage, m[1]!, hit);
      if (RE.entityDynamic.test(text)) push(a.base44.entityUsage, '<dynamic>', hit);
      RE.entityDynamic.lastIndex = 0;
      for (const m of text.matchAll(RE.auth)) push(a.base44.authUsage, m[1]!, hit);
      for (const m of text.matchAll(RE.integration)) push(a.base44.integrationUsage, `${m[1]}.${m[2]}`, hit);
      for (const m of text.matchAll(RE.integrationNamed)) push(a.base44.integrationUsage, `Core.${m[1]}`, hit);
      for (const m of text.matchAll(RE.other)) push(a.base44.otherSdkUsage, m[1]!, hit);
      if (RE.remote.test(text) && a.base44.remoteStorageRefs.length < 200) a.base44.remoteStorageRefs.push(hit);
      RE.remote.lastIndex = 0;
      if (RE.env.test(text) && a.base44.envRefs.length < 100) a.base44.envRefs.push(hit);
      RE.env.lastIndex = 0;
    });
  }

  for (const rel of entityFiles) {
    const schema = await readJson(path.join(root, rel));
    if (schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object') {
      const name = typeof schema.name === 'string' ? schema.name : path.basename(rel).replace(/(\.entity)?\.json$/i, '');
      a.base44.entities.push({ name, file: rel, schema } satisfies EntityInfo);
    } else {
      a.base44.unparsedEntityFiles.push(rel);
    }
  }

  const fw = detectFramework(deps, topFiles);
  a.framework = fw.framework;
  a.frontendBuildDir = fw.buildDir;
  return a;
}
