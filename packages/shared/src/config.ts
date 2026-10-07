import path from 'node:path';
import { z } from 'zod';

const bool = z.union([z.boolean(), z.string()]).transform((v) => v === true || v === 'true' || v === '1');

const schema = z.object({
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://converter:converter@localhost:5432/converter'),
  DATA_DIR: z.string().default('/data'),
  UPLOADS_DIR: z.string().optional(),
  PROJECTS_DIR: z.string().optional(),
  OUTPUT_DIR: z.string().optional(),
  LOGS_DIR: z.string().optional(),
  TEMP_DIR: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(512),
  MAX_UNCOMPRESSED_MB: z.coerce.number().positive().default(2048),
  MAX_ENTRIES: z.coerce.number().int().positive().default(50_000),
  CONCURRENCY: z.coerce.number().int().min(1).default(1),
  VALIDATE_BUILD: bool.default(false),
  WEB_DIST_DIR: z.string().optional(),
});

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  dirs: { data: string; uploads: string; projects: string; output: string; logs: string; temp: string };
  limits: { maxUploadBytes: number; maxUncompressedBytes: number; maxEntries: number; maxRatio: number };
  concurrency: number;
  validateBuild: boolean;
  webDistDir: string | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const e = schema.parse(env);
  const data = path.resolve(e.DATA_DIR);
  const dir = (v: string | undefined, name: string) => path.resolve(v ?? path.join(data, name));
  const mb = 1024 * 1024;
  return {
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    dirs: {
      data,
      uploads: dir(e.UPLOADS_DIR, 'uploads'),
      projects: dir(e.PROJECTS_DIR, 'projects'),
      output: dir(e.OUTPUT_DIR, 'output'),
      logs: dir(e.LOGS_DIR, 'logs'),
      temp: dir(e.TEMP_DIR, 'temp'),
    },
    limits: {
      maxUploadBytes: e.MAX_UPLOAD_MB * mb,
      maxUncompressedBytes: e.MAX_UNCOMPRESSED_MB * mb,
      maxEntries: e.MAX_ENTRIES,
      maxRatio: 200,
    },
    concurrency: e.CONCURRENCY,
    validateBuild: e.VALIDATE_BUILD,
    webDistDir: e.WEB_DIST_DIR ? path.resolve(e.WEB_DIST_DIR) : null,
  };
}
