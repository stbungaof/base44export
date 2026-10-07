import pg from 'pg';
import type { Analysis, Finding, JobStatus, LogEntry, LogLevel, MigrationPlan, StageName, StageRecord, StageStatus } from '@b44/shared';
import { STAGE_NAMES } from '@b44/shared';

const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_name text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text,
  status        text NOT NULL DEFAULT 'queued',
  analysis      jsonb,
  plan          jsonb,
  findings      jsonb NOT NULL DEFAULT '[]',
  output_bytes  bigint,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE job_stages (
  job_id     uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name       text NOT NULL,
  ord        int NOT NULL,
  status     text NOT NULL DEFAULT 'pending',
  started_at timestamptz,
  ended_at   timestamptz,
  error      text,
  PRIMARY KEY (job_id, name)
);
CREATE TABLE job_logs (
  id      bigserial PRIMARY KEY,
  job_id  uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage   text,
  level   text NOT NULL,
  message text NOT NULL,
  ts      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_logs_job_idx ON job_logs(job_id, id);
`,
  },
];

export interface JobRow {
  id: string;
  originalName: string;
  sizeBytes: number;
  sha256: string | null;
  status: JobStatus;
  analysis: Analysis | null;
  plan: MigrationPlan | null;
  findings: Finding[];
  outputBytes: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const toJob = (r: any): JobRow => ({
  id: r.id,
  originalName: r.original_name,
  sizeBytes: Number(r.size_bytes),
  sha256: r.sha256,
  status: r.status,
  analysis: r.analysis,
  plan: r.plan,
  findings: r.findings ?? [],
  outputBytes: r.output_bytes === null ? null : Number(r.output_bytes),
  error: r.error,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

export class Database {
  readonly pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async migrate(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(44044)');
      await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (id int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const done = new Set((await c.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id as number));
      for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        await c.query('BEGIN');
        try {
          await c.query(m.sql);
          await c.query('INSERT INTO schema_migrations(id) VALUES ($1)', [m.id]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        }
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock(44044)').catch(() => {});
      c.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createJob(originalName: string, sizeBytes: number): Promise<JobRow> {
    const { rows } = await this.pool.query('INSERT INTO jobs(original_name, size_bytes) VALUES ($1,$2) RETURNING *', [originalName, sizeBytes]);
    const job = toJob(rows[0]);
    await this.pool.query(
      'INSERT INTO job_stages(job_id, name, ord) SELECT $1, n, o - 1 FROM unnest($2::text[]) WITH ORDINALITY AS t(n, o)',
      [job.id, [...STAGE_NAMES]],
    );
    return job;
  }

  async listJobs(limit = 100): Promise<JobRow[]> {
    const { rows } = await this.pool.query(
      'SELECT id, original_name, size_bytes, sha256, status, NULL::jsonb AS analysis, NULL::jsonb AS plan, findings, output_bytes, error, created_at, updated_at FROM jobs ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(toJob);
  }

  async getJob(id: string): Promise<JobRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async deleteJob(id: string): Promise<boolean> {
    return ((await this.pool.query('DELETE FROM jobs WHERE id = $1', [id])).rowCount ?? 0) > 0;
  }

  async patchJob(
    id: string,
    p: { status?: JobStatus; sha256?: string; analysis?: Analysis; plan?: MigrationPlan; findings?: Finding[]; outputBytes?: number; error?: string | null },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET
         status = COALESCE($2, status), sha256 = COALESCE($3, sha256),
         analysis = COALESCE($4::jsonb, analysis), plan = COALESCE($5::jsonb, plan),
         findings = COALESCE($6::jsonb, findings), output_bytes = COALESCE($7, output_bytes),
         error = CASE WHEN $8::boolean THEN $9 ELSE error END, updated_at = now()
       WHERE id = $1`,
      [
        id,
        p.status ?? null,
        p.sha256 ?? null,
        p.analysis ? JSON.stringify(p.analysis) : null,
        p.plan ? JSON.stringify(p.plan) : null,
        p.findings ? JSON.stringify(p.findings) : null,
        p.outputBytes ?? null,
        p.error !== undefined,
        p.error ?? null,
      ],
    );
  }

  async getStages(jobId: string): Promise<StageRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM job_stages WHERE job_id = $1 ORDER BY ord', [jobId]);
    return rows.map((r) => ({
      name: r.name as StageName,
      status: r.status as StageStatus,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
      endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
      error: r.error,
    }));
  }

  async stageStart(jobId: string, name: StageName): Promise<void> {
    await this.pool.query("UPDATE job_stages SET status='running', started_at=now(), ended_at=NULL, error=NULL WHERE job_id=$1 AND name=$2", [jobId, name]);
  }

  async stageEnd(jobId: string, name: StageName, status: StageStatus, error?: string): Promise<void> {
    await this.pool.query('UPDATE job_stages SET status=$3, ended_at=now(), error=$4 WHERE job_id=$1 AND name=$2', [jobId, name, status, error ?? null]);
  }

  async addLog(jobId: string, stage: StageName | null, level: LogLevel, message: string): Promise<void> {
    await this.pool.query('INSERT INTO job_logs(job_id, stage, level, message) VALUES ($1,$2,$3,$4)', [jobId, stage, level, message.slice(0, 8000)]);
  }

  async getLogs(jobId: string, stage?: string, limit = 2000): Promise<LogEntry[]> {
    const { rows } = await this.pool.query(
      'SELECT stage, level, message, ts FROM job_logs WHERE job_id=$1 AND ($2::text IS NULL OR stage=$2) ORDER BY id LIMIT $3',
      [jobId, stage ?? null, limit],
    );
    return rows.map((r) => ({ stage: r.stage, level: r.level, message: r.message, ts: new Date(r.ts).toISOString() }));
  }

  /** Jobs left 'running'/'queued' by a crashed process can never finish; mark them failed on boot. */
  async failInterruptedJobs(): Promise<number> {
    await this.pool.query("UPDATE job_stages SET status='failed', error='interrupted by restart' WHERE status='running'");
    const r = await this.pool.query("UPDATE jobs SET status='failed', error='interrupted by restart', updated_at=now() WHERE status IN ('running','queued')");
    return r.rowCount ?? 0;
  }
}
