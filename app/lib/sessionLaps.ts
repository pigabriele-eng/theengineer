// The During tab's first section (Gabriele, 2026-10-08: the During tab "should open on: full comparison of the session
// uploaded latest with traces; full comparison should flag laps that have better sections"): every clean lap of the
// latest session, by stint, against the session's fastest lap. What the server answers (GET
// /events/{id}/latest-session/sections, server/app/session_sections.py), the laps put on the traces by default and with
// a tap, and the flags: the corners where a lap holds the session's best time, with what it gained there on the
// fastest lap (only the best per corner: on real data nearly every lap beats the fastest lap somewhere, so flagging
// every one of them flags nothing). Real laps only, never a summed theoretical lap. Pure, so `npm test` checks it; the
// request is in lib/sessionCompare.ts.

export const MAX_PICKS = 6; // the laps a comparison takes (lib/compare.ts MAX_LAPS, POST /compare/laps)
export const MIN_GAIN_S = 0.02; // a section quicker than the fastest lap's by less than this isn't flagged

/** A clean lap: its number, its time and its time in each section (in `sections` order; null while they are worked
 * out, or when the lap couldn't be placed on the fastest lap's line). */
export type SessionLap = { number: number; time: number; sections: number[] | null };

/** One stint (run) of the session, its clean laps in order. */
export type SessionRun = {
  id: number;
  name: string; // as the event page shows it ("R1 stint 2", "05_R2 (2)")
  short: string;
  driver: string | null;
  driver_id: number | null;
  laps: SessionLap[];
};

export type SessionSection = { code: string; start_m: number; end_m: number; apex_m: number | null; corners: string[] };

export type LatestSession = {
  event_id: number;
  status: 'ready' | 'working' | 'empty'; // empty: no timed run yet
  session: { code: string; title: string } | null; // "R1", "05_R2"
  runs: SessionRun[]; // in the order they ran
  left_out: number; // laps that aren't clean (out-laps, in-laps, laps off the pace)
  fastest: { session_id: number; lap: number; time: number } | null;
  sections: SessionSection[] | null; // official corner groups ("T2-T5", "T8/T9"); null until worked out
  numbering: 'official' | 'detected' | null;
  progress: { done: number; total: number } | null; // while working
  note: string | null;
};

export type LapRef = { session_id: number; lap: number };
/** A lap on the traces, with the colour slot it keeps while it is on them. */
export type LapPick = LapRef & { slot: number };
/** A section where a lap was quicker than the fastest lap: `gain` in seconds, negative. */
export type Gain = { code: string; gain: number };

export const sameLap = (a: LapRef, b: LapRef) => a.session_id === b.session_id && a.lap === b.lap;
export const isFastest = (answer: Pick<LatestSession, 'fastest'>, l: LapRef) =>
  answer.fastest != null && sameLap(answer.fastest, l);

/** The fastest lap's own section times, or null while they aren't known. */
export function fastestSections(answer: LatestSession): number[] | null {
  const f = answer.fastest;
  if (!f) return null;
  return answer.runs.find((r) => r.id === f.session_id)?.laps.find((l) => l.number === f.lap)?.sections ?? null;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** "−0.12 s", "+0.42 s" (a minus sign, not a hyphen). */
export const seconds = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)} s`;

/** The flag on a lap: "Best of the session in T6 −0.12 s · T10 −0.05 s" (what it gained there on the fastest lap);
 * null when it holds no corner's best. */
export function flagWords(gs: Gain[] | undefined): string | null {
  if (!gs?.length) return null;
  return `Best of the session in ${gs.map((g) => `${g.code} ${seconds(g.gain)}`).join(' · ')}`;
}

export const lapKey = (l: LapRef) => `${l.session_id}:${l.lap}`;

/** The laps flagged (by lapKey): each corner's best lap of the session (bestInEachCorner) other than the fastest lap,
 * with the corners it holds, the biggest gain first. */
export function bestFlags(answer: LatestSession, min = MIN_GAIN_S): Map<string, Gain[]> {
  const out = new Map<string, Gain[]>();
  for (const b of bestInEachCorner(answer, min)) {
    if (b.fastest) continue;
    const key = lapKey({ session_id: b.run.id, lap: b.lap.number });
    out.set(key, [...(out.get(key) ?? []), { code: b.code, gain: b.gain }].sort((x, y) => x.gain - y.gain));
  }
  return out;
}

/** The lap's gap to the session's fastest lap: "Fastest", or "+0.42 s". */
export const gapWords = (time: number, fastest: number | null | undefined, best: boolean) =>
  best ? 'Fastest' : fastest == null ? '' : seconds(Math.max(0, round(time - fastest)));

export type CornerBest = { code: string; run: SessionRun; lap: SessionLap; gain: number; fastest: boolean };

/** Each section's quickest lap of the session and what it gained there on the fastest lap; the fastest lap itself
 * where no lap was `min` quicker. Empty while the section times aren't known. */
export function bestInEachCorner(answer: LatestSession, min = MIN_GAIN_S): CornerBest[] {
  const fast = fastestSections(answer);
  const f = answer.fastest;
  if (!fast || !f || !answer.sections) return [];
  const fRun = answer.runs.find((r) => r.id === f.session_id)!;
  const fLap = fRun.laps.find((l) => l.number === f.lap)!;
  return answer.sections.map((s, k) => {
    let best: CornerBest = { code: s.code, run: fRun, lap: fLap, gain: 0, fastest: true };
    for (const run of answer.runs) {
      for (const lap of run.laps) {
        const t = lap.sections?.[k];
        if (t == null || lap.sections!.length !== fast.length) continue;
        const gain = round(t - fast[k]);
        if (gain <= -min + 1e-9 && gain < best.gain) best = { code: s.code, run, lap, gain, fastest: false };
      }
    }
    return best;
  });
}

/** The laps on the traces at first: the fastest lap of each stint, in the order they ran; with more stints than a
 * comparison takes, the quickest stints'. */
export function defaultPicks(runs: SessionRun[], max = MAX_PICKS): LapPick[] {
  const bests = runs.flatMap((r, order) => {
    const lap = r.laps.reduce<SessionLap | null>((b, l) => (b == null || l.time < b.time ? l : b), null);
    return lap ? [{ order, session_id: r.id, lap: lap.number, time: lap.time }] : [];
  });
  const kept = [...bests].sort((a, b) => a.time - b.time || a.order - b.order).slice(0, max)
    .sort((a, b) => a.order - b.order);
  return kept.map((b, slot) => ({ session_id: b.session_id, lap: b.lap, slot }));
}

const freeSlot = (picks: LapPick[], max: number) => {
  for (let s = 0; s < max; s++) if (!picks.some((p) => p.slot === s)) return s;
  return picks.length;
};

/** A tap on a lap: off the traces when it is on them, else on them in the lowest free colour slot; `full` when the
 * traces have `max` laps already (nothing changes: one has to come off first). */
export function flipPick(picks: LapPick[], lap: LapRef, max = MAX_PICKS): { picks: LapPick[]; full: boolean } {
  if (picks.some((p) => sameLap(p, lap))) return { picks: picks.filter((p) => !sameLap(p, lap)), full: false };
  return addPick(picks, lap, max);
}

/** A lap taken off the traces (its × above them); the others keep their colours. Down to none: the traces need two. */
export const dropPick = (picks: LapPick[], lap: LapRef): LapPick[] => picks.filter((p) => !sameLap(p, lap));

/** A lap put on the traces: as flipPick, but a lap already on them stays. */
export function addPick(picks: LapPick[], lap: LapRef, max = MAX_PICKS): { picks: LapPick[]; full: boolean } {
  if (picks.some((p) => sameLap(p, lap))) return { picks, full: false };
  if (picks.length >= max) return { picks, full: true };
  return { picks: [...picks, { session_id: lap.session_id, lap: lap.lap, slot: freeSlot(picks, max) }], full: false };
}
