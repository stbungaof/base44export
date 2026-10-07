import fs from 'node:fs/promises';
import { analyze } from '@b44/analyzer';
import { inspectZip, safeExtract } from '@b44/extractor';
import {
  MigrationContext,
  buildPlan,
  generateConfig,
  generateDatabase,
  generateStorage,
  transformSource,
  validateOutput,
  writeReports,
  zipDirectory,
} from '@b44/migration';
import type { Analysis, AppConfig, Finding, LogLevel, MigrationPlan, StageName, StageRecord, StageStatus } from '@b44/shared';
import { STAGE_NAMES, sha256File } from '@b44/shared';
import { LocalStorage } from '@b44/storage';

export interface JobPatch {
  sha256?: string;
  analysis?: Analysis;
  plan?: MigrationPlan;
  findings?: Finding[];
  outputBytes?: number;
}

/** Receives stage lifecycle events, logs and intermediate results (persisted by the API, printed by the CLI). */
export interface StageRecorder {
  stageStart(stage: StageName): void | Promise<void>;
  stageEnd(stage: StageName, status: StageStatus, error?: string): void | Promise<void>;
  log(stage: StageName | null, level: LogLevel, message: string): void | Promise<void>;
  save(patch: JobPatch): void | Promise<void>;
}

export interface PipelineInput {
  jobId: string;
  zipPath: string;
  originalName: string;
  config: AppConfig;
  recorder: StageRecorder;
}

export interface PipelineResult {
  status: 'succeeded' | 'failed';
  stages: StageRecord[];
  projectDir: string;
  zipPath: string;
}

/** Stages whose failure makes later stages meaningless. BUILD_VALIDATE failure still lets us package for inspection. */
const FATAL = new Set<StageName>(['UPLOAD', 'VALIDATE', 'EXTRACT', 'ANALYZE', 'PLAN', 'DATABASE', 'STORAGE', 'TRANSFORM', 'CONFIG']);

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { jobId, zipPath, config, recorder } = input;
  const storage = new LocalStorage(config.dirs);
  await storage.init();
  const extractDir = storage.extractDir(jobId);
  const projectDir = storage.projectDir(jobId);
  const outZip = storage.outputZip(jobId);

  const records: StageRecord[] = STAGE_NAMES.map((name) => ({ name, status: 'pending', startedAt: null, endedAt: null, error: null }));
  let current: StageName | null = null;
  const log = (level: LogLevel, message: string) => recorder.log(current, level, message);
  let sha256: string | null = null;
  let mctx: MigrationContext | null = null;

  const need = (): MigrationContext => {
    if (!mctx) throw new Error('Migration context not initialised');
    return mctx;
  };

  const impl: Record<StageName, () => Promise<void>> = {
    async UPLOAD() {
      const st = await fs.stat(zipPath);
      if (!st.isFile() || st.size === 0) throw new Error('Uploaded file is missing or empty');
      if (st.size > config.limits.maxUploadBytes) throw new Error('Upload exceeds MAX_UPLOAD_MB');
      sha256 = await sha256File(zipPath);
      await log('info', `Received ${input.originalName} (${st.size} bytes, sha256 ${sha256})`);
      await recorder.save({ sha256 });
    },
    async VALIDATE() {
      const r = await inspectZip(zipPath, config.limits);
      await log('info', `${r.entries.length} entries, ${r.totalBytes} bytes uncompressed`);
      if (r.problems.length) throw new Error(r.problems.slice(0, 5).join('; '));
    },
    async EXTRACT() {
      await fs.rm(extractDir, { recursive: true, force: true });
      const r = await safeExtract(zipPath, extractDir, config.limits);
      await log('info', `Extracted ${r.files} files (${r.bytes} bytes)`);
      for (const s of r.skipped) await log('warn', `Skipped ${s}`);
    },
    async ANALYZE() {
      const analysis = await analyze(extractDir);
      await log('info', `Framework: ${analysis.framework}; entities: ${analysis.base44.entities.length}; SDK imports: ${analysis.base44.sdkImports.length}`);
      if (analysis.fileCount === 0) throw new Error('No files found in archive');
      await recorder.save({ analysis });
      await fs.rm(projectDir, { recursive: true, force: true });
      await fs.mkdir(projectDir, { recursive: true });
      mctx = new MigrationContext(jobId, extractDir, projectDir, analysis, (l, m) => void recorder.log(current, l, m));
    },
    async PLAN() {
      const plan = buildPlan(need());
      await log('info', `${plan.steps.length} steps, ${plan.manual.length} item(s) for manual migration`);
      await recorder.save({ plan, findings: need().findings });
    },
    DATABASE: async () => generateDatabase(need()),
    STORAGE: async () => generateStorage(need()),
    TRANSFORM: async () => transformSource(need()),
    CONFIG: async () => generateConfig(need()),
    async BUILD_VALIDATE() {
      const r = await validateOutput(need(), { build: config.validateBuild });
      if (!r.ok) throw new Error(`${r.checks.filter((c) => !c.ok).length} validation check(s) failed`);
    },
    async PACKAGE() {
      const bytes = await zipDirectory(projectDir, outZip);
      await log('info', `Wrote ${outZip} (${bytes} bytes)`);
      await recorder.save({ outputBytes: bytes });
    },
    async REPORT() {
      const c = need();
      // The report is written into the project (so it ships inside the ZIP) and next to the ZIP, then the ZIP is rebuilt.
      // The report is written while REPORT itself is still running; show it as completed in the snapshot.
      const now = new Date().toISOString();
      const snapshot = records.map((r) => (r.name === 'REPORT' ? { ...r, status: 'succeeded' as const, endedAt: now } : r));
      const meta = { jobId, originalName: input.originalName, sha256, stages: snapshot };
      const reportDir = storage.reportPath(jobId, 'md').replace(/[\\/][^\\/]+$/, '');
      await writeReports(c, meta, [projectDir, reportDir]);
      const bytes = await zipDirectory(projectDir, outZip);
      await recorder.save({ findings: c.findings, outputBytes: bytes });
      await log('info', 'Report written');
    },
  };

  for (const rec of records) {
    // After a fatal failure everything else is skipped; a BUILD_VALIDATE failure still lets us package for inspection.
    if (fatalFailure(records)) {
      rec.status = 'skipped';
      await recorder.stageEnd(rec.name, 'skipped');
      continue;
    }
    current = rec.name;
    rec.status = 'running';
    rec.startedAt = new Date().toISOString();
    await recorder.stageStart(rec.name);
    try {
      await impl[rec.name]();
      rec.status = 'succeeded';
    } catch (err) {
      rec.status = 'failed';
      rec.error = err instanceof Error ? err.message : String(err);
      await recorder.log(rec.name, 'error', rec.error);
    }
    rec.endedAt = new Date().toISOString();
    await recorder.stageEnd(rec.name, rec.status, rec.error ?? undefined);
  }
  current = null;
  return { status: records.some((r) => r.status === 'failed') ? 'failed' : 'succeeded', stages: records, projectDir, zipPath: outZip };
}

const fatalFailure = (records: StageRecord[]) => records.some((r) => r.status === 'failed' && FATAL.has(r.name));
