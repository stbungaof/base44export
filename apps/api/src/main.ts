import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { Database } from '@b44/database';
import { loadConfig } from '@b44/shared';
import { LocalStorage } from '@b44/storage';
import Fastify from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { JobRunner } from './jobs';

try {
  process.loadEnvFile();
} catch {
  /* no .env file: rely on the real environment */
}

const config = loadConfig();
const storage = new LocalStorage(config.dirs);
await storage.init();
const db = new Database(config.databaseUrl);
await db.migrate();
const interrupted = await db.failInterruptedJobs();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
if (interrupted) app.log.warn(`${interrupted} interrupted job(s) marked failed`);
await app.register(fastifyMultipart, { limits: { fileSize: config.limits.maxUploadBytes, files: 1 } });

const runner = new JobRunner(db, storage, config, (m, e) => app.log.error({ err: e }, m));
const idParams = z.object({ id: z.string().uuid() });

app.get('/api/health', async () => {
  await db.pool.query('SELECT 1');
  return { ok: true };
});

app.post('/api/jobs', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'Expected a multipart "file" field containing the Base44 export ZIP' });
  const originalName = path.basename(file.filename || 'export.zip').slice(0, 255);
  if (!originalName.toLowerCase().endsWith('.zip')) {
    file.file.resume();
    return reply.code(400).send({ error: 'Only .zip files are accepted' });
  }
  // Write to temp first, then create the job so a failed upload leaves no orphan row.
  const tmp = path.join(config.dirs.temp, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.part`);
  await pipeline(file.file, createWriteStream(tmp));
  if (file.file.truncated) {
    await fs.rm(tmp, { force: true });
    return reply.code(413).send({ error: `File exceeds ${config.limits.maxUploadBytes} bytes` });
  }
  const size = (await fs.stat(tmp)).size;
  const job = await db.createJob(originalName, size);
  await fs.rename(tmp, storage.uploadPath(job.id)).catch(async () => {
    await fs.copyFile(tmp, storage.uploadPath(job.id));
    await fs.rm(tmp, { force: true });
  });
  runner.enqueue(job.id, originalName);
  return reply.code(202).send(job);
});

app.get('/api/jobs', async () => db.listJobs());

app.get('/api/jobs/:id', async (req, reply) => {
  const { id } = idParams.parse(req.params);
  const job = await db.getJob(id);
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  return { ...job, stages: await db.getStages(id) };
});

app.get('/api/jobs/:id/logs', async (req, reply) => {
  const { id } = idParams.parse(req.params);
  const { stage } = z.object({ stage: z.string().optional() }).parse(req.query);
  if (!(await db.getJob(id))) return reply.code(404).send({ error: 'Job not found' });
  return db.getLogs(id, stage);
});

app.get('/api/jobs/:id/download', async (req, reply) => {
  const { id } = idParams.parse(req.params);
  const job = await db.getJob(id);
  const zip = storage.outputZip(id);
  if (!job || !existsSync(zip)) return reply.code(404).send({ error: 'No output available' });
  const base = job.originalName.replace(/\.zip$/i, '').replace(/[^\w.-]+/g, '_');
  return reply
    .header('content-type', 'application/zip')
    .header('content-disposition', `attachment; filename="${base}-self-hosted.zip"`)
    .send(createReadStream(zip));
});

app.get('/api/jobs/:id/report', async (req, reply) => {
  const { id } = idParams.parse(req.params);
  const { format } = z.object({ format: z.enum(['md', 'json']).default('md') }).parse(req.query);
  const file = storage.reportPath(id, format);
  if (!existsSync(file)) return reply.code(404).send({ error: 'Report not available' });
  return reply.header('content-type', format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json').send(createReadStream(file));
});

app.delete('/api/jobs/:id', async (req, reply) => {
  const { id } = idParams.parse(req.params);
  if (!(await db.deleteJob(id))) return reply.code(404).send({ error: 'Job not found' });
  await storage.removeJob(id);
  return reply.code(204).send();
});

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', details: err.issues });
  app.log.error(err);
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  return reply.code(status).send({ error: status === 500 ? 'Internal error' : err.message });
});

// Serve the built web UI when present (production image).
const webDist = config.webDistDir ?? path.resolve('apps/web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  app.setNotFoundHandler((req, reply) =>
    req.method === 'GET' && !req.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Not found' }),
  );
}

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
