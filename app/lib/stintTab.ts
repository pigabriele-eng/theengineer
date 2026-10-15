// The weekend page's Stint analysis tab (components/weekend/StintTab.tsx) in order and in words (Gabriele, 2026-10-15:
// "Stint analysis: 1- balance shift throughout stint 2- tire degradation and fuel load effect"): the weekend's stints,
// race stints first, each named with its driver; where the balance moved most, corner by corner, and how sure that is;
// and the seconds a lap the tyres cost against what burning fuel gives back, and the net. From the event's stint
// view (GET /stint, server/app/analysis/stint.py). Pure, so `npm test` checks it (lib/stintTab.test.mjs).
import type { BalancePhase, Fit, Stint } from './stint';

export const MIN_SHIFT = 0.15; // ° of understeer angle: a smaller shift reads as holding (the server's MIN_BALANCE)
export const MIN_TREND_LAPS = 4; // laps in the trend a stint needs for its trends (the server's MIN_FIT_LAPS)
export const PHASES: BalancePhase[] = ['entry', 'mid', 'exit'];
export const PHASE_LABEL: Record<BalancePhase, string> = { entry: 'Entry', mid: 'Mid-corner', exit: 'Exit' };
const PHASE_AT: Record<BalancePhase, string> = { entry: 'on entry', mid: 'mid-corner', exit: 'on exit' };

// ---------- the stints to pick ----------

/** A run of the weekend as the tab names it: its name, its kind and its driver's code (PIA), when set. */
export type RunInfo = { id: number; name: string; kind?: string | null; driver: string | null };

export type StintChoice = { key: string; label: string; sub: string; group: number };

const RACE = /(^|[^a-z])(r\d+|race)(?![a-z])/i; // "R1 stint 2", "04_R1", "Race 1"; not "FP1", "Practice"
const QUALI = /(^|[^a-z])(q\d*|pq|quali\w*)(?![a-z])/i; // "Q1", "03_Q", "Qualifying"

/** Where a run's stints come in the list: a race first (0), then practice and tests (1), qualifying last (2). */
export function runGroup(name: string, kind?: string | null): number {
  if (kind === 'race' || RACE.test(name)) return 0;
  if (kind === 'qualifying' || QUALI.test(name)) return 2;
  return 1;
}

/** A stint's name: its run's, with the stint's number when the run's log has more than one ("R1 · stint 2"). */
export function stintTitle(stint: Pick<Stint, 'file_key' | 'run' | 'number' | 'session_id'>, all: Pick<Stint,
  'file_key'>[], runs: RunInfo[]): string {
  const name = runs.find((r) => r.id === stint.session_id)?.name ?? stint.run;
  return all.filter((s) => s.file_key === stint.file_key).length > 1 ? `${name} · stint ${stint.number}` : name;
}

/** The stint's driver's code, or "No driver". */
export function driverOf(stint: Pick<Stint, 'session_id'>, runs: RunInfo[]): string {
  return runs.find((r) => r.id === stint.session_id)?.driver ?? 'No driver';
}

/** The weekend's stints with a trend to read (four laps in it or more), race stints first, then in the order the
 * runs ran (`runs` in the weekend's order), each named with its driver; and the names of the ones too short. The
 * picked stint stays in the list when tagging a lap takes it under four. */
export function stintChoices(stints: Stint[], runs: RunInfo[], picked?: string | null): {
  choices: StintChoice[]; short: string[];
} {
  const order = new Map(runs.map((r, i) => [r.id, i]));
  const sorted = stints.map((s, i) => {
    const run = runs.find((r) => r.id === s.session_id);
    return { s, i, group: runGroup(run?.name ?? s.run, run?.kind), at: order.get(s.session_id ?? -1) ?? runs.length };
  }).sort((a, b) => a.group - b.group || a.at - b.at || a.i - b.i);
  const choices: StintChoice[] = [];
  const short: string[] = [];
  for (const { s, group } of sorted) {
    const title = stintTitle(s, stints, runs);
    if (s.fitted_laps < MIN_TREND_LAPS && s.key !== picked) {
      short.push(title);
      continue;
    }
    choices.push({ key: s.key, label: `${title} · ${driverOf(s, runs)}`, group,
      sub: `laps ${s.first_lap}–${s.last_lap} · ${s.fitted_laps} in the trend` });
  }
  return { choices, short };
}

// ---------- the balance shift ----------

const sign = (v: number, digits = 2) => {
  const t = Math.abs(v).toFixed(digits);
  return Number(t) === 0 ? t : `${v > 0 ? '+' : '−'}${t}`;
};
const way = (shift: number) => (shift > 0 ? 'towards understeer' : 'towards oversteer');
const join = (items: string[]) => (items.length <= 1 ? items.join('')
  : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const lapList = (laps: number[]) => join(laps.map(String));

/** A corner's balance shift in one phase: early laps against late laps (the median of each), and whether its trend
 * lap by lap stands clear of the lap-to-lap scatter (null: no trend, too few laps). */
export type Shift = { code: string; phase: BalancePhase; early: number; late: number; shift: number;
  clear: boolean | null };

/** Every corner's shift in every phase, the biggest first. */
export function shifts(stint: Pick<Stint, 'sections' | 'balance_laps'>): Shift[] {
  const out: Shift[] = [];
  for (const s of stint.sections) {
    if (!s.corner) continue;
    const laps = stint.balance_laps?.corners.find((c) => c.code === s.code);
    for (const p of PHASES) {
      const b = s[p];
      if (!b) continue;
      const t = laps?.[p]?.trend;
      out.push({ code: s.code, phase: p, early: b.early, late: b.late, shift: b.shift, clear: t ? t.clear : null });
    }
  }
  return out.sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift));
}

export const shiftWords = (s: Shift) => `${s.code} ${PHASE_AT[s.phase]}`;

/** Where the balance moved most through the stint, in words: the headline (the biggest shift, early laps to late
 * laps), the next ones, how sure (each shift's trend lap by lap against the scatter) and the whole lap's trend per
 * phase. */
export function balanceWords(stint: Pick<Stint, 'sections' | 'balance_laps' | 'groups' | 'fits' | 'laps'>): {
  headline: string; next: string | null; sure: string | null; whole: string | null;
} {
  const none = { next: null, sure: null, whole: null };
  if (!stint.laps.some((l) => l.in_fit && l.balance && PHASES.some((p) => l.balance![p] != null))) {
    return { headline: 'No balance for this stint: its log needs a steering angle and a yaw rate.', ...none };
  }
  const g = stint.groups;
  if (!g) {
    return { headline: `Too few laps in the trend to see the balance move: it takes ${MIN_TREND_LAPS}.`, ...none };
  }
  const all = shifts(stint);
  const moved = all.filter((s) => Math.abs(s.shift) >= MIN_SHIFT);
  const span = `from the early laps (${lapList(g.early)}) to the late laps (${lapList(g.late)})`;
  const whole = wholeLap(stint.fits);
  if (moved.length === 0) {
    return { headline: `The balance holds in every corner: none moves more than ${MIN_SHIFT}° ${span}.`, next: null,
      sure: null, whole };
  }
  const top = moved[0];
  const headline = `The balance moves most at ${shiftWords(top)}: ${sign(top.shift)}° ${way(top.shift)}, ${span}.`;
  const rest = moved.slice(1, 3);
  const next = rest.length ? `Then ${join(rest.map((s) => `${shiftWords(s)} (${sign(s.shift)}°, ${way(s.shift)})`))}.`
    : null;
  const clear = moved.filter((s) => s.clear);
  const known = moved.filter((s) => s.clear != null);
  let sure: string | null = null;
  if (known.length) {
    const n = moved.length;
    const of = `${n} ${n === 1 ? 'shift' : 'shifts'} over ${MIN_SHIFT}°`;
    sure = clear.length === 0
      ? `Lap by lap, none of the ${of} stands clear of the lap-to-lap scatter: read ${n === 1 ? 'it' : 'them'} as a lean to watch, not a sure change.`
      : clear.length === known.length
        ? `Lap by lap, ${n === 1 ? 'it stands' : `all ${n} stand`} clear of the lap-to-lap scatter.`
        : `Lap by lap, ${clear.length} of the ${of} ${clear.length === 1 ? 'stands' : 'stand'} clear of the lap-to-lap scatter${clear.length > 3 ? ', the biggest' : ':'} ${join(clear.slice(0, 3).map(shiftWords))}; the others are a lean to watch.`;
  }
  return { headline, next, sure, whole };
}

/** The whole lap's balance per phase through the stint (the trend's change, first to last lap): which phases move
 * clearly by more than MIN_SHIFT, and which hold. */
export function wholeLap(fits: Partial<Record<string, Fit>>): string | null {
  const moved: string[] = [];
  const held: string[] = [];
  for (const p of PHASES) {
    const t = fits[`balance_${p}`];
    if (!t) continue;
    if (t.clear && Math.abs(t.change) >= MIN_SHIFT) {
      moved.push(`${PHASE_LABEL[p].toLowerCase()} moves ${Math.abs(t.change).toFixed(2)}° ${way(t.change)}`);
    } else held.push(PHASE_LABEL[p].toLowerCase());
  }
  if (!moved.length && !held.length) return null;
  if (!moved.length) return `Over the whole lap the balance holds in every phase (within ±${MIN_SHIFT}°).`;
  const holds = held.length ? `; ${join(held)} ${held.length === 1 ? 'holds' : 'hold'}` : '';
  return `Over the whole lap ${join(moved)}${holds}.`;
}

// ---------- tyres and fuel ----------

export type Part = { per_lap: number; within: number | null; clear: boolean | null; total: number };

/** The stint's lap time trend split in two (fits from the server): what the tyres cost a lap (the lap times with the
 * fuel burnt put back on), what burning the fuel gives back, and the net (the lap times as driven); each also over
 * the laps in the trend, from the first to the last, and the fuel burnt over them. Without a fuel figure only the
 * net is known. */
export type Split = {
  tyres: Part | null;
  fuel: (Part & { kg_per_lap: number | null; measured: boolean; s_per_10kg: number; burnt_kg: number | null }) | null;
  net: Part | null;
  from: number | null; // the first and last lap in the trend
  to: number | null;
  laps: number; // laps in the trend
};

export function fuelSplit(stint: Pick<Stint, 'fits' | 'fuel' | 'laps' | 'fitted_laps'>): Split {
  const raw = stint.fits.time;
  const cor = stint.fits.corrected_time;
  const inFit = stint.laps.filter((l) => l.in_fit);
  const from = inFit[0]?.lap ?? null;
  const to = inFit[inFit.length - 1]?.lap ?? null;
  const part = (t: Fit | undefined): Part | null => (t ? { per_lap: t.per_lap, within: t.within, clear: t.clear,
    total: t.change } : null);
  const f = stint.fuel;
  let fuel: Split['fuel'] = null;
  if (f && f.fuel_s_per_lap != null && cor) {
    // burnt from the start of the first lap in the trend to the start of the last (each lap's own fuel used)
    const kg = stint.laps.filter((l) => from != null && to != null && l.lap >= from && l.lap < to)
      .map((l) => l.fuel_kg);
    const burnt = kg.length && kg.every((v) => v != null) ? kg.reduce((a, b) => a + (b ?? 0), 0) : null;
    // the parts add up: the fuel's share of the change over the stint is what the raw trend has and the tyres don't
    fuel = { per_lap: f.fuel_s_per_lap, within: null, clear: null, total: raw ? raw.change - cor.change : 0,
      kg_per_lap: f.kg_per_lap, measured: f.source === 'log', s_per_10kg: f.s_per_10kg, burnt_kg: burnt };
  }
  return { tyres: fuel ? part(cor) : null, fuel, net: part(raw), from, to, laps: stint.fitted_laps };
}

const s2 = (v: number) => `${Math.abs(v).toFixed(2)} s`;
const s1 = (v: number) => `${Math.abs(v).toFixed(1)} s`;

/** The split in words: the headline (tyres against fuel, and the net, a lap and over the stint) and how sure each
 * figure is. */
export function splitWords(sp: Split): { headline: string; sure: string[] } {
  if (!sp.net || sp.from == null || sp.to == null) {
    return { headline: `Too few laps in the trend for a fade: it takes ${MIN_TREND_LAPS}.`, sure: [] };
  }
  const over = `Over laps ${sp.from} to ${sp.to}`;
  const scatter = (p: Part) => `±${(p.within ?? 0).toFixed(2)} s a lap over ${sp.laps} laps`;
  const sure: string[] = [];
  if (!sp.tyres || !sp.fuel) {
    const n = sp.net;
    const said = !n.clear ? `the lap times hold within the scatter (${sign(n.per_lap)} s a lap)`
      : n.per_lap > 0 ? `the lap times fade ${s2(n.per_lap)} a lap, ${s1(n.total)} by the end`
        : `the lap times come down ${s2(n.per_lap)} a lap`;
    sure.push(`Lap times: ${n.clear ? 'a clear trend' : 'within the lap-to-lap scatter'} (${scatter(n)}).`);
    return { headline: `${over} ${said}. Without a fuel figure the tyres and the fuel can’t be told apart.`, sure };
  }
  const { tyres: t, fuel: f, net: n } = sp;
  const tyres = !t.clear ? `the tyres show no clear fade (${sign(t.per_lap)} s a lap, within the scatter)`
    : t.per_lap > 0 ? `the tyres cost ${s2(t.per_lap)} a lap, ${s1(t.total)} by lap ${sp.to}`
      : `the car got ${s2(t.per_lap)} a lap quicker even with the fuel put back: the tyres (or the track) still coming in`;
  const burnt = f.burnt_kg != null ? `${f.burnt_kg.toFixed(1)} kg of fuel` : 'the fuel';
  const fuel = `burning ${burnt} gave back ${s2(f.per_lap)} a lap${Math.abs(f.total) >= 0.05 ? `, ${s1(f.total)} in all` : ''}`;
  const net = !n.clear ? `Net, the lap times hold within the scatter (${sign(n.per_lap)} s a lap).`
    : n.per_lap > 0 ? `Net, the car lost ${s2(n.per_lap)} a lap: on the trend lap ${sp.to} was ${s1(n.total)} slower than lap ${sp.from}.`
      : `Net, the car got ${s2(n.per_lap)} a lap quicker: on the trend lap ${sp.to} was ${s1(n.total)} quicker than lap ${sp.from}.`;
  sure.push(`Tyres: ${t.clear ? 'a clear trend, bigger than' : 'within'} the lap-to-lap scatter (${scatter(t)}).`);
  sure.push(f.measured
    ? `Fuel: the fuel used is measured by the log${f.kg_per_lap != null ? ` (${f.kg_per_lap.toFixed(2)} kg a lap)` : ''}; what each 10 kg costs (${f.s_per_10kg.toFixed(2)} s a lap here) comes from the laps’ own full-throttle running and leaves out the tyres losing a little grip with the load, so the real gain is likely a little bigger.`
    : `Fuel: an estimate from the time at full throttle (the log has no fuel channel)${f.kg_per_lap != null ? `, ${f.kg_per_lap.toFixed(2)} kg a lap` : ''}: take it as a guide.`);
  sure.push(`Net: ${n.clear ? 'a clear trend, bigger than' : 'within'} the lap-to-lap scatter (${scatter(n)}).`);
  return { headline: `${over} ${tyres}; ${fuel}. ${net}`, sure };
}
