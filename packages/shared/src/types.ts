export const STAGE_NAMES = [
  'UPLOAD',
  'VALIDATE',
  'EXTRACT',
  'ANALYZE',
  'PLAN',
  'DATABASE',
  'STORAGE',
  'TRANSFORM',
  'CONFIG',
  'BUILD_VALIDATE',
  'PACKAGE',
  'REPORT',
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** `manual` = could not be converted automatically; original code is preserved and needs human work. */
export type FindingSeverity = 'info' | 'warning' | 'manual';

export interface Finding {
  id: string;
  severity: FindingSeverity;
  category: string;
  message: string;
  file?: string;
  line?: number;
  snippet?: string;
}

export interface Hit {
  file: string;
  line: number;
  snippet: string;
}

export interface EntityInfo {
  name: string;
  file: string;
  schema: Record<string, unknown>;
}

export interface Analysis {
  /** Project root relative to the extraction dir ('' = extraction root). */
  projectRoot: string;
  fileCount: number;
  totalBytes: number;
  framework: string;
  frontendBuildDir: string | null;
  packageManager: string;
  packageName: string | null;
  dependencies: Record<string, string>;
  base44: {
    packages: Record<string, string>;
    sdkImports: Hit[];
    entityUsage: Record<string, Hit[]>;
    authUsage: Record<string, Hit[]>;
    integrationUsage: Record<string, Hit[]>;
    otherSdkUsage: Record<string, Hit[]>;
    remoteStorageRefs: Hit[];
    envRefs: Hit[];
    configFiles: string[];
    backendFunctions: string[];
    entities: EntityInfo[];
    unparsedEntityFiles: string[];
  };
}

export interface PlanStep {
  id: string;
  stage: StageName;
  title: string;
  automatic: boolean;
  details?: string;
}

export interface MigrationPlan {
  steps: PlanStep[];
  manual: Finding[];
}

export interface ChangeRecord {
  file: string;
  kind: 'rewrite-import' | 'edit-package-json' | 'add-file';
  detail: string;
}

export interface StageRecord {
  name: StageName;
  status: StageStatus;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}

export interface LogEntry {
  stage: StageName | null;
  level: LogLevel;
  message: string;
  ts: string;
}
