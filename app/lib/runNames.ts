// Runs named after the official session each ran in (server/app/results/run_names.py): the event's questions about
// runs that don't sit clearly in one session, and the one-tap answer. A server without it, or an event without an
// official timetable, has no questions: then nothing is shown.
import { apiFetch } from '@/lib/api';

export type RunNameOption = { code: string; label: string }; // "Q1", "Qualifying 1"

export type RunNameQuestion = {
  session_id: number;
  name: string | null; // the run's name now
  starts: string | null; // when the log starts, in the track's time ("2026-06-20T10:42:00")
  options: RunNameOption[];
};

export type RunNames = {
  named: { session_id: number; name: string; code: string }[];
  questions: RunNameQuestion[];
  note?: string;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail) ? body.detail.map((d: { msg: string }) => d.msg).join('; ') : body.detail;
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const runNamesApi = {
  event: (eventId: number) => call<RunNames>(`/results/events/${eventId}/run-names`),
  /** The official session the run ran in, or null: in none of them (it keeps its name). */
  answer: (sessionId: number, code: string | null) =>
    call<RunNames>(`/results/run-names/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }),
};
