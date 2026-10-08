// Tyres for each stint (Gabriele, 2026-10-08: "when uploading a stint you can add a check for tires 'new, fresh, used,
// very used'"): right under an upload's result, and later from a run's hold menu on the event page. Which runs get a
// row, the app's guess against the driver's own pick, and what "Confirm all" sends. Pure, so `npm test` checks it; the
// requests are in lib/eventTyres.ts, the rows in components/TyrePicks.tsx.
import type { RunTyres, TyreLevel } from './tyreLevels';

/** A run's tyres as GET /technique/events/{id}/tyres has them: with the driver's own pick, the app's guess beside it. */
export type ServerTyres = RunTyres & { guess?: TyreLevel };

/** A run of GET /technique/events/{id}/tyres (server/app/routers/technique.py event_tyres), in the order they ran. */
export type TyresRun = {
  id: number;
  name: string; // as the event page names it ("FP1 stint 1", "Q1", "03_Q (2)")
  short: string;
  day: number | null;
  date: string | null;
  time: string | null;
  driver: string | null;
  tyres: ServerTyres | null;
};
export type EventTyres = { levels: { key: TyreLevel; label: string }[]; runs: TyresRun[] };

/** One stint's row: its name and driver, the level ticked (the driver's pick, else the app's guess) and why. */
export type TyreRow = {
  id: number;
  name: string;
  driver: string | null;
  level: TyreLevel;
  mine: boolean; // the driver set it: shown as confirmed, never overwritten by a guess
  why: string; // the guess's short why ("qualifying: always a new set", "12 laps on the set before this run")
};

/** Whether the driver set these tyres: the server then sends its own guess beside the pick ("set by you"). A
 * qualifying or race run comes back sure by rule (qualifying on a new set, the races on its set) without anybody
 * having said so: that is still the app's pick, offered to confirm like any other guess. */
export const isMine = (t: ServerTyres) => t.guess !== undefined || t.why === 'set by you';

/** A run's row, or null when the server has no tyres for it. */
export function rowOf(run: TyresRun): TyreRow | null {
  const t = run.tyres;
  if (!t) return null;
  const mine = isMine(t);
  return { id: run.id, name: run.name, driver: run.driver, level: t.tyres, mine, why: mine ? '' : t.why };
}

/** The rows of an upload: its runs (`ids`) among the event's, in the order they ran (the server's), each once; a run
 * of the event that isn't the upload's, or that the server has no tyres for, gets none. */
export function uploadRows(runs: TyresRun[], ids: Iterable<number>): TyreRow[] {
  const wanted = new Set(ids);
  const out: TyreRow[] = [];
  for (const r of runs) {
    if (!wanted.has(r.id)) continue;
    wanted.delete(r.id);
    const row = rowOf(r);
    if (row) out.push(row);
  }
  return out;
}

/** The runs of an upload worth a row: the runs it made and the logs it skipped as already in the app (the same
 * stints, uploaded again: their tyres show as they were left, the driver's picks confirmed). */
export function uploadRunIds(job: { session_ids: number[]; skipped?: { already?: boolean; session_id?: number }[] }) {
  const again = (job.skipped ?? []).filter((s) => s.already && s.session_id != null).map((s) => s.session_id!);
  return [...new Set([...job.session_ids, ...again])];
}

/** The line under a row: the driver's pick as confirmed, else the guess with its short why. */
export const rowNote = (row: TyreRow) => (row.mine ? 'Confirmed' : row.why ? `Guess · ${row.why}` : 'Guess');

/** What a screen reader says of one of a row's four choices: "Tyres for Q1, PIA: Used, a guess" for the one ticked,
 * "Tyres for Q1, PIA: Fresh" for the others. */
export function choiceSpeech(row: TyreRow, code: string | null, level: TyreLevel, label: string): string {
  const who = code ? `, ${code}` : '';
  const state = level === row.level ? (row.mine ? ', confirmed' : ', a guess') : '';
  return `Tyres for ${row.name}${who}: ${label}${state}`;
}

/** The row once the driver has picked `level` (saved at once). */
export const picked = (row: TyreRow, level: TyreLevel): TyreRow => ({ ...row, level, mine: true, why: '' });

export type TyresPut = { id: number; tyres: TyreLevel };

/** What "Confirm all" sends, one PUT per stint: every shown row's ticked level, except where the driver's own pick is
 * already there, shown here or on the server now (`now`, the rows read again just before, so a pick made since on
 * another screen is never overwritten by a guess). */
export function confirmAll(rows: TyreRow[], now: TyreRow[] = []): TyresPut[] {
  const theirs = new Set(now.filter((r) => r.mine).map((r) => r.id));
  return rows.filter((r) => !r.mine && !theirs.has(r.id)).map((r) => ({ id: r.id, tyres: r.level }));
}

/** The rows after "Confirm all": the ones saved confirmed, and any the driver set elsewhere since as they are now. */
export function afterConfirm(rows: TyreRow[], saved: TyresPut[], now: TyreRow[] = []): TyreRow[] {
  const done = new Map(saved.map((p) => [p.id, p.tyres]));
  const theirs = new Map(now.filter((r) => r.mine).map((r) => [r.id, r]));
  return rows.map((r) => (done.has(r.id) ? picked(r, done.get(r.id)!) : !r.mine && theirs.has(r.id) ? theirs.get(r.id)! : r));
}

/** How many rows are still the app's guess. */
export const guesses = (rows: TyreRow[]) => rows.filter((r) => !r.mine).length;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The line said after "Confirm all". */
export function confirmedWords(sent: number, failed: number): string {
  if (failed) return `Couldn’t save ${plural(failed, 'stint')}: try again.`;
  return sent ? `Saved the tyres of ${plural(sent, 'stint')}.` : 'Every stint’s tyres were already confirmed.';
}
