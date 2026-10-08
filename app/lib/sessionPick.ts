// Which session the During tab's comparison shows (Gabriele, 2026-10-08: "quickly select other sessions or runs to
// compare. Standard it should open the latest session but should be possible to tap the session and change it to
// something else"): the latest session at first; another one with a tap; stints of other sessions mixed in with a
// tick. Held for the visit only. Pure, so `npm test` checks it (lib/sessionPick.test.mjs); the picker is
// components/weekend/SessionPicker.tsx and the answer comes from GET /events/{id}/latest-session/sections
// (?part=, ?add=; server/app/session_sections.py).

/** A session to pick, as the server lists them (in the order they ran). */
export type SessionChoice = {
  code: string; // "FP1", "Q1", "05_R2"
  title: string;
  laps: number; // clean laps
  drivers: string[];
  runs: { id: number; name: string; short: string; driver: string | null; laps: number }[];
};

/** What is picked: a session (null: the latest) and runs of other sessions mixed in. */
export type SessionPick = { part: string | null; add: number[] };

export const LATEST: SessionPick = { part: null, add: [] };

/** True when the pick is the latest session alone (what the tab opens on). */
export const isLatest = (pick: SessionPick, latest: string | null | undefined) =>
  pick.add.length === 0 && (pick.part == null || pick.part === latest);

/** The query the pick asks with: "" for the latest session alone. */
export function queryOf(pick: SessionPick): string {
  const q: string[] = [];
  if (pick.part != null) q.push(`part=${encodeURIComponent(pick.part)}`);
  if (pick.add.length) q.push(`add=${[...pick.add].sort((a, b) => a - b).join(',')}`);
  return q.length ? `?${q.join('&')}` : '';
}

/** Another session: its own laps only (the stints mixed in before are dropped). */
export const pickSession = (code: string, latest: string | null | undefined): SessionPick =>
  ({ part: code === latest ? null : code, add: [] });

/** A stint of another session ticked in or out. */
export function flipAdd(pick: SessionPick, id: number): SessionPick {
  return { ...pick, add: pick.add.includes(id) ? pick.add.filter((x) => x !== id) : [...pick.add, id] };
}

/** The session shown: the picked one, else the latest. */
export const shownCode = (pick: SessionPick, latest: string | null | undefined) => pick.part ?? latest ?? null;

/** The words on the picker's button: "R2 · latest", "FP1", "FP1 + 2 stints". */
export function pickWords(title: string, latest: boolean, added: number): string {
  const head = latest ? `${title} · latest` : title;
  return added ? `${head} + ${added} ${added === 1 ? 'stint' : 'stints'}` : head;
}

const lapsWords = (n: number) => `${n} ${n === 1 ? 'lap' : 'laps'}`;

/** A session's line in the list: "14 laps · Piana, Rackl". */
export function choiceDetail(c: SessionChoice): string {
  return [lapsWords(c.laps), c.drivers.length ? c.drivers.join(', ') : 'Driver not set'].join(' · ');
}

/** A stint's line in "Add runs from other sessions": "6 laps · Piana". */
export function stintDetail(r: SessionChoice['runs'][number]): string {
  return `${lapsWords(r.laps)} · ${r.driver ?? 'Driver not set'}`;
}

/** The stints that can be mixed in: every timed stint of the other sessions, by session in the order they ran. */
export function otherStints(choices: SessionChoice[], shown: string | null): SessionChoice[] {
  return choices.filter((c) => c.code !== shown && c.runs.some((r) => r.laps > 0))
    .map((c) => ({ ...c, runs: c.runs.filter((r) => r.laps > 0) }));
}
