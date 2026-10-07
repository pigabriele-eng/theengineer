// The report's figures ask the server again by themselves when it couldn't answer just now, instead of showing
// "Failed to fetch". That happens while the server wakes up (the free plan sleeps after 15 min idle; waking takes
// about 30 s) or restarts after a deploy: the browser then gets no answer at all, or Render's 502-504; and the
// server answers 503 when it is only busy. A read is asked again after 2, 4, 8, 15, 15… s for up to RETRY_FOR_MS;
// when it still gets no answer, the error says so in plain words. Meanwhile the report says what it is waiting for
// (components/report/ServerNote.tsx, from readsNow()).
import { apiFetch } from '@/lib/api';

const RETRY_STATUS = new Set([502, 503, 504]);
const RETRY_FOR_MS = 90_000;
const WAITS_MS = [2_000, 4_000, 8_000, 15_000];

export const NO_ANSWER = 'The server didn’t answer. It may be restarting: reload the page in a minute.';

// ---------- what the figures are waiting for, for the note on the report ----------

type Read = { since: number; waiting: 'answer' | 'wake' | 'busy' };
const reads = new Map<number, Read>();
let nextRead = 0;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

/** Whether a read waits for the server to wake up, for it to be less busy, and since when the oldest one waits. */
export function readsNow(): { waking: boolean; busy: boolean; oldest: number | null } {
  let oldest: number | null = null;
  let waking = false;
  let busy = false;
  for (const r of reads.values()) {
    oldest = oldest == null ? r.since : Math.min(oldest, r.since);
    waking ||= r.waiting === 'wake';
    busy ||= r.waiting === 'busy';
  }
  return { waking, busy, oldest };
}

export function onReadsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** apiFetch for a figure's read (GET), asked again while the server can't answer. */
export async function apiFetchAgain(path: string): Promise<Response> {
  const id = nextRead++;
  const start = Date.now();
  const mark = (waiting: Read['waiting']) => {
    reads.set(id, { since: start, waiting });
    changed();
  };
  mark('answer');
  try {
    for (let attempt = 0; ; attempt++) {
      const pause = WAITS_MS[Math.min(attempt, WAITS_MS.length - 1)];
      const more = Date.now() - start + pause < RETRY_FOR_MS;
      let res: Response;
      try {
        res = await apiFetch(path);
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        if (!more) throw new Error(NO_ANSWER);
        mark('wake');
        await wait(pause);
        mark('answer');
        continue;
      }
      if (!more || !RETRY_STATUS.has(res.status)) return res;
      mark(res.status === 503 ? 'busy' : 'wake');
      await wait(pause);
      mark('answer');
    }
  } finally {
    reads.delete(id);
    changed();
  }
}
