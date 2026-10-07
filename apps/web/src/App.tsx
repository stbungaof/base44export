import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Job, type LogLine } from './api';

const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const active = (j: Job) => j.status === 'queued' || j.status === 'running';

export function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => api.list().then(setJobs).catch((e: Error) => setError(e.message)), []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const job = await api.upload(file);
      setSelected(job.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shell">
      <header>
        <h1>Base44 Local Converter</h1>
        <p>Turn a Base44 export ZIP into a self-hosted project (PostgreSQL + local storage).</p>
      </header>

      <div
        className={`drop ${drag ? 'over' : ''}`}
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => (e.preventDefault(), setDrag(false), void upload(e.dataTransfer.files[0]))}
        onClick={() => input.current?.click()}
      >
        <input ref={input} type="file" accept=".zip" hidden onChange={(e) => void upload(e.target.files?.[0])} />
        {busy ? 'Uploading…' : 'Drop a Base44 export .zip here, or click to choose'}
      </div>
      {error && <div className="error">{error}</div>}

      <div className="cols">
        <section>
          <h2>Jobs</h2>
          {jobs.length === 0 && <p className="muted">No conversions yet.</p>}
          <ul className="jobs">
            {jobs.map((j) => (
              <li key={j.id} className={j.id === selected ? 'sel' : ''} onClick={() => setSelected(j.id)}>
                <span className={`badge ${j.status}`}>{j.status}</span>
                <strong>{j.originalName}</strong>
                <span className="muted">
                  {fmtBytes(j.sizeBytes)} · {new Date(j.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section>{selected ? <Detail id={selected} onDeleted={() => (setSelected(null), void refresh())} /> : <p className="muted">Select a job.</p>}</section>
      </div>
    </div>
  );
}

function Detail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api.get(id);
        if (stop) return;
        setJob(j);
        if (showLogs) setLogs(await api.logs(id));
        if (active(j) || showLogs) timer = setTimeout(() => void tick(), 1500);
      } catch {
        /* job removed */
      }
    };
    void tick();
    return () => ((stop = true), clearTimeout(timer));
  }, [id, showLogs]);

  if (!job) return <p className="muted">Loading…</p>;
  const manual = job.findings.filter((f) => f.severity === 'manual');
  const warn = job.findings.filter((f) => f.severity === 'warning');
  const done = job.status === 'succeeded' || job.status === 'failed';

  return (
    <div>
      <h2>{job.originalName}</h2>
      <p>
        <span className={`badge ${job.status}`}>{job.status}</span>
        {job.analysis && (
          <span className="muted">
            {' '}
            {job.analysis.framework} · {job.analysis.fileCount} files · {job.analysis.base44.entities.length} entities
          </span>
        )}
      </p>
      {job.error && <div className="error">{job.error}</div>}

      <h3>Pipeline</h3>
      <ol className="stages">
        {job.stages?.map((s) => (
          <li key={s.name} className={s.status}>
            <span className="dot" />
            <span className="sname">{s.name}</span>
            <span className="muted">
              {s.status}
              {s.startedAt && s.endedAt ? ` · ${((+new Date(s.endedAt) - +new Date(s.startedAt)) / 1000).toFixed(1)}s` : ''}
            </span>
            {s.error && <div className="error small">{s.error}</div>}
          </li>
        ))}
      </ol>

      {done && job.stages?.some((s) => s.name === 'PACKAGE' && s.status === 'succeeded') && (
        <p className="actions">
          <a className="btn" href={api.downloadUrl(id)}>Download self-hosted project</a>
          <a className="btn ghost" href={api.reportUrl(id)} target="_blank" rel="noreferrer">Migration report</a>
        </p>
      )}

      {manual.length > 0 && (
        <>
          <h3>Needs manual migration ({manual.length})</h3>
          <ul className="findings">
            {manual.map((f) => (
              <li key={f.id}>
                <span className="badge manual">{f.category}</span> {f.message}
                {f.file && <code> {f.file}{f.line ? `:${f.line}` : ''}</code>}
              </li>
            ))}
          </ul>
        </>
      )}
      {warn.length > 0 && (
        <>
          <h3>Warnings ({warn.length})</h3>
          <ul className="findings">
            {warn.map((f) => (
              <li key={f.id}>
                <span className="badge warning">{f.category}</span> {f.message}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="actions">
        <button className="btn ghost" onClick={() => setShowLogs((v) => !v)}>{showLogs ? 'Hide logs' : 'Show logs'}</button>
        {done && (
          <button className="btn danger" onClick={() => window.confirm('Delete this job and its files?') && void api.remove(id).then(onDeleted)}>
            Delete
          </button>
        )}
      </p>
      {showLogs && (
        <pre className="logs">
          {logs.map((l) => `${l.ts.slice(11, 19)} ${(l.stage ?? '-').padEnd(14)} ${l.level.padEnd(5)} ${l.message}`).join('\n')}
        </pre>
      )}
    </div>
  );
}
