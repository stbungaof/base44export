import path from 'node:path';
import type { Analysis, ChangeRecord, Finding, LogLevel, MigrationPlan } from '@b44/shared';

export interface EntityTable {
  name: string;
  table: string;
  columns: Record<string, { pgType: string; json: boolean }>;
}

/** Mutable state shared by the migration stages of one job. */
export class MigrationContext {
  readonly findings: Finding[] = [];
  readonly changes: ChangeRecord[] = [];
  plan: MigrationPlan | null = null;
  entityTables: EntityTable[] = [];
  /** Path (relative to project/app) of the installed compatibility layer, if any. */
  shimPath: string | null = null;
  frontendConvertible = false;
  /** Free-form key/value facts the report prints (e.g. validation results). */
  readonly facts: Record<string, string> = {};

  constructor(
    readonly jobId: string,
    readonly extractDir: string,
    /** Directory of the generated, deployable project (contains app/, server/, original/). */
    readonly projectDir: string,
    readonly analysis: Analysis,
    private readonly logger: (level: LogLevel, message: string) => void,
  ) {}

  /** Absolute path of the Base44 project root inside the extracted ZIP (never modified). */
  get sourceRoot(): string {
    return path.join(this.extractDir, this.analysis.projectRoot);
  }
  get appDir(): string {
    return path.join(this.projectDir, 'app');
  }
  get serverDir(): string {
    return path.join(this.projectDir, 'server');
  }
  get originalDir(): string {
    return path.join(this.projectDir, 'original');
  }

  log(level: LogLevel, message: string): void {
    this.logger(level, message);
  }

  addFinding(f: Omit<Finding, 'id'>): Finding {
    const finding: Finding = { id: `F${String(this.findings.length + 1).padStart(3, '0')}`, ...f };
    this.findings.push(finding);
    this.log(f.severity === 'info' ? 'info' : 'warn', `[${f.severity}] ${f.category}: ${f.message}`);
    return finding;
  }
}
