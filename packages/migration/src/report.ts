import fs from 'node:fs/promises';
import path from 'node:path';
import type { Finding, StageRecord } from '@b44/shared';
import type { MigrationContext } from './context';

export interface ReportMeta {
  jobId: string;
  originalName: string;
  sha256: string | null;
  stages: StageRecord[];
}

const icon = (s: Finding['severity']) => (s === 'manual' ? 'MANUAL' : s === 'warning' ? 'WARN' : 'INFO');

export function buildReportJson(ctx: MigrationContext, meta: ReportMeta) {
  const a = ctx.analysis;
  return {
    generatedAt: new Date().toISOString(),
    job: meta,
    detection: {
      framework: a.framework,
      projectRoot: a.projectRoot || '.',
      packageManager: a.packageManager,
      files: a.fileCount,
      base44Packages: a.base44.packages,
      entities: a.base44.entities.map((e) => e.name),
      integrations: Object.keys(a.base44.integrationUsage),
      authCalls: Object.keys(a.base44.authUsage),
    },
    plan: ctx.plan,
    changes: ctx.changes,
    findings: ctx.findings,
    facts: ctx.facts,
    summary: {
      manualItems: ctx.findings.filter((f) => f.severity === 'manual').length,
      warnings: ctx.findings.filter((f) => f.severity === 'warning').length,
      tables: ctx.entityTables.map((t) => t.table),
    },
  };
}

export function buildReportMarkdown(ctx: MigrationContext, meta: ReportMeta): string {
  const a = ctx.analysis;
  const manual = ctx.findings.filter((f) => f.severity === 'manual');
  const others = ctx.findings.filter((f) => f.severity !== 'manual');
  const L: string[] = [];
  L.push(`# Migration report`, '');
  L.push(`- Source: \`${meta.originalName}\`${meta.sha256 ? ` (sha256 \`${meta.sha256.slice(0, 16)}...\`)` : ''}`);
  L.push(`- Job: \`${meta.jobId}\``);
  L.push(`- Framework detected: **${a.framework}** (project root: \`${a.projectRoot || '.'}\`, ${a.fileCount} files)`);
  L.push(`- Entities: ${a.base44.entities.map((e) => e.name).join(', ') || 'none found'}`);
  L.push(`- Items needing manual work: **${manual.length}**`, '');

  L.push('## Needs manual migration', '');
  if (manual.length === 0) L.push('Nothing flagged.');
  for (const f of manual) L.push(`- **[${f.category}]** ${f.message}${f.file ? ` (\`${f.file}${f.line ? ':' + f.line : ''}\`)` : ''}`);
  L.push('');

  L.push('## Other findings', '');
  if (others.length === 0) L.push('None.');
  for (const f of others) L.push(`- ${icon(f.severity)} [${f.category}] ${f.message}${f.file ? ` (\`${f.file}\`)` : ''}`);
  L.push('');

  L.push('## Plan', '');
  for (const s of ctx.plan?.steps ?? []) L.push(`- ${s.automatic ? '[auto]' : '[manual]'} ${s.stage}: ${s.title}${s.details ? ` - ${s.details}` : ''}`);
  L.push('');

  L.push('## Files changed or generated', '');
  for (const c of ctx.changes) L.push(`- \`${c.file}\` - ${c.kind}: ${c.detail}`);
  L.push('');

  L.push('## Stages', '', '| Stage | Status | Start | End |', '|---|---|---|---|');
  for (const s of meta.stages) L.push(`| ${s.name} | ${s.status}${s.error ? ` (${s.error})` : ''} | ${s.startedAt ?? ''} | ${s.endedAt ?? ''} |`);
  L.push('');

  if (Object.keys(ctx.facts).length) {
    L.push('## Validation', '');
    for (const [k, v] of Object.entries(ctx.facts)) L.push(`- ${k}: ${v}`);
    L.push('');
  }
  L.push('The original source is preserved unchanged in `original/`.', '');
  return L.join('\n');
}

export async function writeReports(ctx: MigrationContext, meta: ReportMeta, outDirs: string[]): Promise<void> {
  const json = JSON.stringify(buildReportJson(ctx, meta), null, 2);
  const md = buildReportMarkdown(ctx, meta);
  for (const dir of outDirs) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'MIGRATION_REPORT.json'), json);
    await fs.writeFile(path.join(dir, 'MIGRATION_REPORT.md'), md);
  }
}
