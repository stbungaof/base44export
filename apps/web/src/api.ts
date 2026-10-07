export type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface Stage {
  name: string;
  status: StageStatus;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}
export interface Finding {
  id: string;
  severity: 'info' | 'warning' | 'manual';
  category: string;
  message: string;
  file?: string;
  line?: number;
}
export interface Job {
  id: string;
  originalName: string;
  sizeBytes: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  findings: Finding[];
  error: string | null;
  createdAt: string;
  analysis?: { framework: string; fileCount: number; base44: { entities: { name: string }[] } } | null;
  stages?: Stage[];
}
export interface LogLine {
  stage: string | null;
  level: string;
  message: string;
  ts: string;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* keep statusText */
    }
    throw new Error(msg);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  list: () => req<Job[]>('/api/jobs'),
  get: (id: string) => req<Job>(`/api/jobs/${id}`),
  logs: (id: string) => req<LogLine[]>(`/api/jobs/${id}/logs`),
  remove: (id: string) => req<void>(`/api/jobs/${id}`, { method: 'DELETE' }),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<Job>('/api/jobs', { method: 'POST', body: fd });
  },
  downloadUrl: (id: string) => `/api/jobs/${id}/download`,
  reportUrl: (id: string) => `/api/jobs/${id}/report`,
};
