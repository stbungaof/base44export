import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '@b44/shared';

/** Per-job directory layout on the local filesystem. All paths are derived from configurable roots. */
export class LocalStorage {
  constructor(private readonly dirs: AppConfig['dirs']) {}

  async init(): Promise<void> {
    await Promise.all(Object.values(this.dirs).map((d) => fs.mkdir(d, { recursive: true })));
  }

  private jobId(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid job id');
    return id;
  }

  uploadPath(jobId: string): string {
    return path.join(this.dirs.uploads, `${this.jobId(jobId)}.zip`);
  }
  extractDir(jobId: string): string {
    return path.join(this.dirs.projects, this.jobId(jobId), 'extracted');
  }
  /** Root of the generated, deployable project. */
  projectDir(jobId: string): string {
    return path.join(this.dirs.output, this.jobId(jobId), 'project');
  }
  outputZip(jobId: string): string {
    return path.join(this.dirs.output, this.jobId(jobId), 'self-hosted-project.zip');
  }
  reportPath(jobId: string, ext: 'json' | 'md'): string {
    return path.join(this.dirs.output, this.jobId(jobId), `MIGRATION_REPORT.${ext}`);
  }
  logFile(jobId: string): string {
    return path.join(this.dirs.logs, `${this.jobId(jobId)}.log`);
  }

  async appendLog(jobId: string, line: string): Promise<void> {
    await fs.appendFile(this.logFile(jobId), line + '\n');
  }

  async removeJob(jobId: string): Promise<void> {
    const id = this.jobId(jobId);
    await Promise.all([
      fs.rm(path.join(this.dirs.projects, id), { recursive: true, force: true }),
      fs.rm(path.join(this.dirs.output, id), { recursive: true, force: true }),
      fs.rm(this.uploadPath(id), { force: true }),
      fs.rm(this.logFile(id), { force: true }),
    ]);
  }
}
