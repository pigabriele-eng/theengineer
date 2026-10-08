// The weekend page's Laps tab (Gabriele, 2026-10-07: "Compare laps, during the weekend, should be the standard
// function that opens when clicking on the event"): which tab the page opens on, and the suggested comparisons in
// words. Pure, so `npm test` checks it; the request is in lib/lapSuggestions.ts, the tab in
// components/weekend/Laps.tsx.
import type { SuggestedCorner, SuggestedLap, Suggestion } from './lapSuggestions';
import type { Stage } from './weekendRuns';

/** The weekend page's tabs: Laps, then the weekend's three stages. */
export type WeekendTab = 'laps' | Stage;

export const TABS: WeekendTab[] = ['laps', 'before', 'during', 'after'];

/** The tab the page opens on when none is asked for, from the stage it would open on (lib/weekendRuns.ts
 * defaultStage): Laps while the weekend is on, so the first thing is the laps to compare; Before while there are no
 * runs and After once it is over, as before. */
export const openingTab = (stage: Stage): WeekendTab => (stage === 'during' ? 'laps' : stage);

/** The tab the address asks for, if it is one. */
export const askedTab = (asked: string | undefined): WeekendTab | null =>
  TABS.includes(asked as WeekendTab) ? (asked as WeekendTab) : null;

const sec = (s: number) => `${s.toFixed(2)} s`;

/** "T10 0.41 s · T11-T12 0.29 s": the corners where most of the gap is, biggest first. */
export const cornerWords = (corners: SuggestedCorner[]) => corners.map((c) => `${c.code} ${sec(c.loss_s)}`).join(' · ');

// a time and its unit never apart at the end of a line
const secTogether = (s: number) => `${s.toFixed(2)} s`;

/** "throttle on and off (0.17 s)": the technique check's mistake of the slower lap at the corner, if it found one. */
export const mistakeWords = (c: SuggestedCorner): string | null =>
  (c.mistake ? `${c.mistake.words} (${secTogether(c.mistake.cost_s)})` : null);

/** The same for a screen reader: "T10, 0.41 seconds, throttle on and off there, costing 0.17 seconds; T11-T12, 0.29
 * seconds". */
export const cornerSpeech = (corners: SuggestedCorner[]) =>
  corners.map((c) => `${c.code}, ${c.loss_s.toFixed(2)} seconds${c.mistake
    ? `, ${c.mistake.words} there, costing ${c.mistake.cost_s.toFixed(2)} seconds` : ''}`).join('; ');

/** What the technique check found at each of a suggestion's corners, by corner, in words for the comparison's
 * "Where the time is" ("Technique check: throttle on and off here, 0.17 s"). */
export function mistakeNotes(corners: SuggestedCorner[] | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of corners ?? []) {
    if (c.mistake) out[c.code] = `Technique check: ${c.mistake.words} here, ${secTogether(c.mistake.cost_s)}`;
  }
  return out;
}

/** What a suggestion compares, in a few words: "Teammates · qualifying", "PIA · R2 against R1",
 * "PIA · best and typical lap, R1 stint 1". `code` gives a driver's tag (lib/driverTag.ts codeOf). */
export function suggestionTitle(s: Suggestion, code: (driver: string | null) => string | null): string {
  const [a, b] = s.laps;
  const who = code(a.driver);
  const mine = (words: string) => (who ? `${who} · ${words}` : words);
  if (s.kind === 'teammates') {
    if (s.tyres === 'used') return 'Teammates · used tyres';
    return a.kind === 'qualifying' && b.kind === 'qualifying' ? 'Teammates · qualifying' : 'Teammates · new tyres';
  }
  if (s.kind === 'progress') return mine(`${a.session} against ${b.session}`);
  return mine(`best and typical lap, ${a.run}`);
}

/** A lap's or a run's tyres in words: its level's label ("Very used tyres", lib/tyreLevels.ts) where the server says
 * it, else new or used; a guess says so ("Fresh tyres (guess)"). */
export function tyreWords(t: { tyres: string; tyres_sure?: boolean; tyres_label?: string }): string {
  return `${t.tyres_label ?? t.tyres} tyres${t.tyres_sure === false ? ' (guess)' : ''}`;
}

/** One lap's line after its time: "03_Q (2) · lap 2 · New tyres", "R1 stint 1 · lap 8 · typical lap · Fresh tyres";
 * a guessed tyre state says so. */
export function lapWords(l: SuggestedLap): string {
  return [l.run, `lap ${l.lap}`, l.role === 'typical' ? 'typical lap' : null, tyreWords(l)].filter(Boolean).join(' · ');
}

/** The whole suggestion for a screen reader, ending with what a tap does. `time` formats a lap time. */
export function suggestionSpeech(s: Suggestion, code: (driver: string | null) => string | null,
  time: (t: number) => string): string {
  const lap = (l: SuggestedLap) => `${code(l.driver) ?? 'Driver not set'} ${time(l.time)}, ${lapWords(l)}`;
  const corners = s.corners?.length ? ` Most of the gap: ${cornerSpeech(s.corners)}.` : '';
  return `${suggestionTitle(s, code)}. ${lap(s.laps[0])}, against ${lap(s.laps[1])}. ${s.gap_s.toFixed(2)} seconds apart.${corners}`;
}

/** The laps ticked by hand, with one more ticked or unticked; at most `max`. */
export function toggleLap<T extends { session_id: number; lap: number }>(picks: T[], lap: T, max: number): T[] {
  const i = picks.findIndex((p) => p.session_id === lap.session_id && p.lap === lap.lap);
  if (i >= 0) return picks.filter((_, k) => k !== i);
  return picks.length >= max ? picks : [...picks, lap];
}
