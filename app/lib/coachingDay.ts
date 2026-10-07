// A coaching day's answers from what the server already gives: the coaching days among the events, the lap every
// client is measured against (the event's quickest), and where a client's lap loses time to it, corner by corner
// (POST /compare/laps). Each driver's latest run is lib/weekendRuns.ts latestByDriver, as on a race weekend. Pure, so
// it is tested in lib/coachingDay.test.mjs (npm test): no imports but types.
import type { CompareResult } from './compare';
import type { Folder, FolderSummary } from './events';
import type { WithMode } from './eventModes';

/** How many numbered sections a coaching day (components/coaching/CoachingDay.tsx) puts before the event page's own:
 * three things, did we fix it, corner by corner, debriefs. */
export const COACHING_SECTIONS = 4;

/** The coaching days among the events, newest first (as GET /events/folders orders them). */
export function coachingDays<F extends FolderSummary & WithMode>(folders: F[]): F[] {
  return folders.filter((f) => f.id != null && f.mode === 'coaching');
}

/** The lap a coaching day measures every client against: the event's quickest clean lap. */
export type Reference = { session_id: number; lap: number; time: number; run: string; driver: string | null };

export function referenceLap(folder: Pick<Folder, 'days' | 'best_session_id'>): Reference | null {
  const run = folder.days.flatMap((d) => d.sessions).find((s) => s.id === folder.best_session_id);
  if (!run || run.best_lap == null || run.best_lap_s == null) return null;
  return { session_id: run.id, lap: run.best_lap, time: run.best_lap_s, run: run.name, driver: run.driver };
}

/** One corner (or group of corners, as the analysis groups them: "T8/T9", "T2-T5") of a client's lap against the
 * reference lap: the time lost there (negative: gained), the phase where most of it went and what the client did
 * differently, in words. */
export type CornerLoss = {
  code: string;
  start_m: number;
  end_m: number;
  loss_s: number;
  phase: string | null;
  phase_loss_s: number | null;
  words: string | null;
};

/** Every corner of lap `lap` against lap `ref` in a comparison of the two, the most time lost first. */
export function cornerLosses(data: Pick<CompareResult, 'sections' | 'opportunities'>, lap = 0, ref = 1): CornerLoss[] {
  const why = new Map((data.opportunities[lap]?.sections ?? []).filter((o) => o.versus === ref).map((o) => [o.code, o]));
  return data.sections.map((s) => {
    const o = why.get(s.code);
    const text = o?.differences.map((d) => d.text).join(', ');
    return {
      code: s.code, start_m: s.start_m, end_m: s.end_m,
      loss_s: Math.round((s.times[lap] - s.times[ref]) * 1000) / 1000,
      phase: o?.phase ?? null, phase_loss_s: o?.phase_loss_s ?? null,
      words: text ? `${text[0].toUpperCase()}${text.slice(1)}.` : null,
    };
  }).sort((a, b) => b.loss_s - a.loss_s);
}

const PHASE_WORDS: Record<string, string> = {
  braking: 'under braking', entry: 'on the way in', 'mid-corner': 'in the middle of the corner', exit: 'on the way out',
  'full throttle': 'at full throttle',
};

/** Where in the corner the time went, in words: "Most of it on the way out: +0.09 s". The phase's loss is measured on
 * its own, so it can be more than the corner's (time made up in another phase) or a small part of it. */
export function phaseLine(loss: Pick<CornerLoss, 'loss_s' | 'phase' | 'phase_loss_s'>): string | null {
  if (!loss.phase || loss.phase_loss_s == null || loss.loss_s < 0.01) return null;
  const where = PHASE_WORDS[loss.phase] ?? loss.phase;
  const amount = lossText(loss.phase_loss_s);
  if (loss.phase_loss_s > loss.loss_s + 0.005) return `${where[0].toUpperCase()}${where.slice(1)} alone: ${amount}`;
  if (loss.phase_loss_s >= loss.loss_s / 2) return `Most of it ${where}: ${amount}`;
  return `The biggest part ${where}: ${amount}`;
}

/** The points of a trace that fall in [from, to] metres: the first and last index. */
export function pointWindow(distance: number[], from: number, to: number): [number, number] {
  let a = distance.findIndex((d) => d >= from);
  if (a < 0) a = distance.length - 1;
  let b = distance.length - 1;
  while (b > a && distance[b] > to) b--;
  return [a, b];
}

/** "+0.42 s", "−0.05 s": time lost (or gained) in seconds. */
export const lossText = (s: number, digits = 2) =>
  `${s > 0 ? '+' : s < 0 ? '−' : '±'}${Math.abs(s).toFixed(digits)} s`;
