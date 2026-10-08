// The tyres on every run row, one tap from changing them (Gabriele, 2026-10-08: "give me the ability to manually
// quickly edit the tire on the run"): a tag beside the run's driver, "New", "Fresh", "Used" or "Very used", with a "?"
// while it is the app's guess; a tap opens the four levels under the row, a second tap saves one and closes them. The
// driver's own pick always wins over a guess (lib/tyrePicks.ts isMine). Pure, so `npm test` checks it; the shared
// reads and saves are in components/TyreTag.tsx.
import type { TyreLevel } from './tyreLevels';
import type { TyreRow } from './tyrePicks';

/** What the tag shows: the level's label, with "?" when the app guessed it (`mine` false). */
export type TyreTag = { text: string; label: string; level: TyreLevel; mine: boolean };

/** A run's tag, or null when the app has no tyres for it (a run in no event, or one without laps). */
export function tyreTag(row: TyreRow | null | undefined, labels: Record<TyreLevel, string>): TyreTag | null {
  if (!row) return null;
  const label = labels[row.level] ?? row.level;
  return { text: row.mine ? label : `${label}?`, label, level: row.level, mine: row.mine };
}

/** What a screen reader says of the tag: "Tyres of 01_D1S1: Used, a guess. Change"; the driver's pick plainly. */
export const tagSpeech = (tag: TyreTag, run: string) =>
  `Tyres of ${run}: ${tag.label}${tag.mine ? '' : ', a guess'}. Change`;

/** What tapping one of the four levels sends (PUT /technique/sessions/{id}/tyres), or null when nothing would change:
 * the driver's own pick tapped again only closes the levels. The app's guess tapped as it is is sent: that makes it the
 * driver's, never to be guessed over again. */
export function tapSends(row: TyreRow, level: TyreLevel): { id: number; tyres: TyreLevel } | null {
  return row.mine && row.level === level ? null : { id: row.id, tyres: level };
}

/** Whose levels are open after a tap on run `id`'s tag: its own, or none when they were open already. */
export const toggled = (open: number | null, id: number) => (open === id ? null : id);

/** The rows read again from the server, but a run whose pick is still being saved (or was saved after this read left)
 * as it is shown: the read can't know of it yet, and must not put the old guess back. */
export function merged(read: Map<number, TyreRow>, shown: Map<number, TyreRow> | null,
  keep: Iterable<number>): Map<number, TyreRow> {
  const out = new Map(read);
  for (const id of keep) {
    const row = shown?.get(id);
    if (row) out.set(id, row);
  }
  return out;
}
