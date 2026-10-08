// What the report's Drivers section asks the server (components/report/DriversCompare.tsx), for two drivers' runs on
// one tyre level: each corner by group with their lap times on one tyre age and fuel load (GET
// /report/drivers/corners), each one's balance per corner and phase (GET /report/drivers/balance) and the technique
// check's repeated mistakes of each (GET /report/drivers/flags). The server keeps each answer, so opening the report
// again costs nothing.
import type { BalanceSection, DriversCorners, Flag, Side } from '@/lib/reportDrivers';
import { apiFetchAgain } from '@/lib/retry';

async function read<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail) ? body.detail.map((d: { msg: string }) => d.msg).join('; ') : body.detail;
    throw new Error(detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const ids = (runs: number[]) => runs.join(',');

export const fetchDriversCorners = (a: number[], b: number[]) =>
  apiFetchAgain(`/report/drivers/corners?a=${ids(a)}&b=${ids(b)}`).then((r) => read<DriversCorners>(r));

export type DriversBalance = {
  track: string | null;
  labels: Record<Side, string>;
  laps: Record<Side, number>;
  per_g: number | null;
  numbering: 'official' | 'detected';
  sections: BalanceSection[];
  runs: { name: string; session_id: number; laps: number; note?: string }[];
  quickest_laps?: { used: number; of: number };
};

export const fetchDriversBalance = (a: number[], b: number[]) =>
  apiFetchAgain(`/report/drivers/balance?a=${ids(a)}&b=${ids(b)}`).then((r) => read<DriversBalance>(r));

export type DriversFlags = { status: 'ready' | 'none' } & Record<Side, Flag[]>;

export const fetchDriversFlags = (a: number[], b: number[]) =>
  apiFetchAgain(`/report/drivers/flags?a=${ids(a)}&b=${ids(b)}`).then((r) => read<DriversFlags>(r));
