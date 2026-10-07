import { runPipeline } from '@b44/core';
import type { Database } from '@b44/database';
import type { AppConfig } from '@b44/shared';
import type { LocalStorage } from '@b44/storage';

/** In-process job queue with bounded concurrency. Job state lives in PostgreSQL. */
export class JobRunner {
  private queue: { id: string; originalName: string }[] = [];
  private active = 0;

  constructor(
    private readonly db: Database,
    private readonly storage: LocalStorage,
    private readonly config: AppConfig,
    private readonly log: (msg: string, err?: unknown) => void,
  ) {}

  enqueue(id: string, originalName: string): void {
    this.queue.push({ id, originalName });
    this.pump();
  }

  private pump(): void {
    while (this.active < this.config.concurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.active++;
      this.execute(next.id, next.originalName)
        .catch((e) => this.log(`job ${next.id} crashed`, e))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  private async execute(id: string, originalName: string): Promise<void> {
    const { db } = this;
    await db.patchJob(id, { status: 'running', error: null });
    // Serialise DB writes so log ordering is stable.
    let chain: Promise<unknown> = Promise.resolve();
    const q = <T>(fn: () => Promise<T>) => (chain = chain.then(fn, fn));
    const result = await runPipeline({
      jobId: id,
      zipPath: this.storage.uploadPath(id),
      originalName,
      config: this.config,
      recorder: {
        stageStart: (s) => void q(() => db.stageStart(id, s)),
        stageEnd: (s, st, err) => void q(() => db.stageEnd(id, s, st, err)),
        log: (s, level, m) => void q(async () => {
          await db.addLog(id, s, level, m);
          await this.storage.appendLog(id, `${new Date().toISOString()} [${s ?? '-'}] ${level} ${m}`);
        }),
        save: (p) => void q(() => db.patchJob(id, p)),
      },
    });
    await chain;
    const failed = result.stages.find((s) => s.status === 'failed');
    await db.patchJob(id, { status: result.status, error: failed ? `${failed.name}: ${failed.error}` : null });
  }
}
