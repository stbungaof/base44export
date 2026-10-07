# Architecture

```
apps/web        React + Vite UI (upload, live stage view, findings, download)
apps/api        Fastify API + in-process job queue; persists to PostgreSQL
packages/shared      types, env config (zod), fs helpers
packages/extractor   ZIP inspection + safe extraction (zip-slip, zip-bomb, symlink, size limits)
packages/analyzer    framework + Base44 detection from actual file contents
packages/migration   plan, DB/storage/source/config generators, validation, packaging, report
packages/storage     per-job directory layout under /data/{uploads,projects,output,logs,temp}
packages/database    converter's own PostgreSQL schema (jobs, job_stages, job_logs) + migrations
packages/core        pipeline runner: stage lifecycle, status/time/logs/errors per stage
```

## Pipeline

UPLOAD → VALIDATE → EXTRACT → ANALYZE → PLAN → DATABASE → STORAGE → TRANSFORM → CONFIG → BUILD_VALIDATE → PACKAGE → REPORT

Each stage records status, start/end time, log lines and error. A failure in any stage up to CONFIG skips the
rest. A BUILD_VALIDATE failure marks the job failed but still packages the output for inspection.

## Principles

- Nothing is assumed about the export layout; the analyzer reports only what it finds.
- The extracted source is never modified. `project/original/` is a verbatim copy; `project/app/` is the working copy.
- Anything not convertible is a `manual` finding in the report; the original code is kept in place.
- Only exact `@base44/sdk` import specifiers are rewritten. Other `@base44/*` packages are flagged, not touched.

## Output project

```
project/
  original/   untouched Base44 source
  app/        converted frontend (+ src/lib/local-base44 compatibility layer)
  server/     Fastify API: generic entity CRUD, /api/files (local uploads), single local user
  Dockerfile  docker-compose.yml  .env.example  README.md  MIGRATION_REPORT.{md,json}
```

## What the generated backend supports (and does not)

Supported: `entities.X.list/filter/get/create/bulkCreate/update/delete` with equality filters, sort, limit, skip;
`integrations.Core.UploadFile`; `auth.me/isAuthenticated/logout` for one local user.
Not supported (throws a clear error, listed in the report): other integrations (InvokeLLM, SendEmail, ...),
functions, agents, real authentication, operator filters (`$gt`, `$in`, ...), data import.
