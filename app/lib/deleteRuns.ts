// Client for deleting chosen runs (server/app/run_delete.py): what deleting the ticked runs would remove, then deleting
// them with their logs and everything kept for them. Their event stays, with its other runs.
import { apiFetch } from '@/lib/api';

// What the runs hold: their laps, their logs, every stored file (logs, lap traces, technique checks, recordings) and the
// bytes those take in storage (null: unknown).
export type RunsSize = { session_ids: number[]; name: string; runs: number; laps: number; logs: number; files: number;
  bytes: number | null };
export type RunsDeleted = Omit<RunsSize, 'session_ids'> & { deleted: number[]; events: number[];
  rows: Record<string, number> };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const runsApi = {
  size: (ids: number[]) => call<RunsSize>(`/runs/size?ids=${ids.join(',')}`),
  remove: (ids: number[]) => call<RunsDeleted>(`/runs?ids=${ids.join(',')}`, { method: 'DELETE' }),
};
