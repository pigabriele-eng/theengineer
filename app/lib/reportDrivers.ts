// The report's Drivers section (Gabriele, 2026-10-08: "in the reporting page, i would like to add a "driver"
// comparison"; "for example I want to compare FP1 but have in the report a driver comparison, like a balance
// comparison"): the two drivers of the report's runs on one tyre level, like with like. What is picked and in what
// order, from what the report and the server answer: which drivers drove on which level and how many laps each, the
// level and the pair compared, each corner's numbers side by side and the driving differences in words, the corners
// biggest gap first, what was matched, the balance per phase, grip use per driver, and the laps offered for the traces
// (real laps, never a summed one). Pure, so `npm test` checks it (reportDrivers.test.mjs); the requests are in
// lib/reportDriversApi.ts and the section is components/report/DriversCompare.tsx.
// "All" tyres (Gabriele, 2026-10-09: "add a possibility to compare drivers even with different tyre mileage"): every
// driver's laps on every level together, a choice next to the levels; the lap times are put on one tyre age and fuel
// load as on one level, and the words say which tyres each driver's laps were on.
import type { TyreLevel } from './tyreLevels';

export type Side = 'a' | 'b';
export const SIDES: Side[] = ['a', 'b'];

/** A real lap: its run, its number and its time. */
export type DriverLap = { session_id: number; lap: number; time: number };

/** One driver on one tyre level: their runs there and every clean lap of them, quickest first. On "All" tyres, also
 * the levels they drove on. */
export type DriverOnLevel = { name: string; code: string; runs: number[]; laps: DriverLap[]; tyres?: TyreLevel[] };

/** Every tyre level at once: the drivers' laps whatever tyres they were on. */
export const ALL = 'all';
export type LevelKey = TyreLevel | typeof ALL;

/** One tyre level of the report (or all of them) and who drove on it, the most laps first. */
export type LevelDrivers = { tyres: LevelKey; drivers: DriverOnLevel[] };

/** "All" for every level, else the level's own label. */
export const levelLabel = (k: LevelKey) => (k === ALL ? 'All' : TYRE_WORDS[k]);
/** "all tyres", "fresh tyres", "very used tyres". */
export const tyreWords = (k: LevelKey) => `${k === ALL ? 'all' : TYRE_WORDS[k].toLowerCase()} tyres`;
// as lib/tyreLevels.ts TYRE_LEVELS and TYRE_LABEL (only its types are read here, so the tests run this file alone)
const TYRE_ORDER: TyreLevel[] = ['new', 'fresh', 'used', 'worn'];
const TYRE_WORDS: Record<TyreLevel, string> = { new: 'New', fresh: 'Fresh', used: 'Used', worn: 'Very used' };

/** What the report says of one tyre level (lib/report.ts Report): its runs, and its clean laps by run name. */
export type LevelReport = {
  condition?: { tyres: TyreLevel | null; runs: number[] } | null;
  trends: { runs: { run: string; session_id: number | null }[]; laps: { run: string; lap: number; time: number }[] };
};

/** A driver's short code from their name: the first three letters of the last name in capitals ("Max Piana" PIA);
 * a shorter name as it is (as lib/driverTag.ts driverCode). */
export function codeOf(name: string): string {
  const s = (name.trim().split(/\s+/).at(-1) ?? '').replace(/[^\p{L}\p{N}]/gu, '');
  return s.length >= 3 ? s.slice(0, 3).toUpperCase() : name.trim();
}

/** Each tyre level of the report and the drivers on it, from the report of every level (the report's own, unfiltered:
 * a driver picked in its lap filter doesn't hide the other) and who drove each run now. A run with no driver set is
 * left out: it can't be put on either side. */
export function levelDrivers(levels: LevelReport[], driverOf: (sessionId: number) => string | null | undefined):
  LevelDrivers[] {
  const out: LevelDrivers[] = [];
  for (const r of levels) {
    const tyres = r.condition?.tyres;
    if (!tyres || out.some((l) => l.tyres === tyres)) continue;
    const runOf = new Map(r.trends.runs.filter((x) => x.session_id != null).map((x) => [x.run, x.session_id!]));
    const by = new Map<string, DriverOnLevel>();
    for (const id of r.condition?.runs ?? []) {
      const name = driverOf(id)?.trim();
      if (!name) continue;
      const d = by.get(name) ?? { name, code: codeOf(name), runs: [], laps: [] };
      if (!d.runs.includes(id)) d.runs.push(id);
      by.set(name, d);
    }
    for (const l of r.trends.laps) {
      const id = runOf.get(l.run);
      const name = id != null ? driverOf(id)?.trim() : null;
      const d = name ? by.get(name) : undefined;
      if (d && id != null && d.runs.includes(id)) d.laps.push({ session_id: id, lap: l.lap, time: l.time });
    }
    const drivers = [...by.values()].filter((d) => d.laps.length > 0);
    for (const d of drivers) {
      d.runs.sort((x, y) => x - y);
      d.laps.sort((x, y) => x.time - y.time || x.session_id - y.session_id || x.lap - y.lap);
    }
    drivers.sort((x, y) => y.laps.length - x.laps.length || x.name.localeCompare(y.name));
    out.push({ tyres, drivers });
  }
  return out;
}

/** Every level at once, for "All": each driver's runs and laps on every level together (laps quickest first), with
 * the levels they drove on. null when it would add nothing: under two drivers, or one level only. */
export function allLevels(levels: LevelDrivers[]): LevelDrivers | null {
  const driven = levels.filter((l) => l.tyres !== ALL && l.drivers.length > 0);
  if (driven.length < 2) return null;
  const by = new Map<string, DriverOnLevel>();
  for (const l of driven) {
    for (const d of l.drivers) {
      const m = by.get(d.name) ?? { name: d.name, code: d.code, runs: [], laps: [], tyres: [] };
      for (const id of d.runs) if (!m.runs.includes(id)) m.runs.push(id);
      m.laps.push(...d.laps);
      if (!m.tyres!.includes(l.tyres as TyreLevel)) m.tyres!.push(l.tyres as TyreLevel);
      by.set(d.name, m);
    }
  }
  const drivers = [...by.values()];
  if (drivers.length < 2) return null;
  for (const d of drivers) {
    d.runs.sort((x, y) => x - y);
    d.laps.sort((x, y) => x.time - y.time || x.session_id - y.session_id || x.lap - y.lap);
    d.tyres!.sort((x, y) => TYRE_ORDER.indexOf(x) - TYRE_ORDER.indexOf(y));
  }
  drivers.sort((x, y) => y.laps.length - x.laps.length || x.name.localeCompare(y.name));
  return { tyres: ALL, drivers };
}

/** The tyre level of each run of the report. */
export function levelOfRun(levels: LevelDrivers[]): Map<number, TyreLevel> {
  const out = new Map<number, TyreLevel>();
  for (const l of levels) {
    if (l.tyres === ALL) continue;
    for (const d of l.drivers) for (const id of d.runs) if (!out.has(id)) out.set(id, l.tyres);
  }
  return out;
}

/** The tyre levels of each side's runs, in the levels' order (new first). */
export function sideTyres(runs: Record<Side, number[]>, levelOf: Map<number, TyreLevel>): Record<Side, TyreLevel[]> {
  const out = {} as Record<Side, TyreLevel[]>;
  for (const side of SIDES) {
    const mine = new Set(runs[side].map((id) => levelOf.get(id)).filter((t): t is TyreLevel => t != null));
    out[side] = TYRE_ORDER.filter((t) => mine.has(t));
  }
  return out;
}

/** Every driver of the report's runs, on any level. */
export const allDrivers = (levels: LevelDrivers[]) => [...new Set(levels.flatMap((l) => l.drivers.map((d) => d.name)))];

/** Laps two drivers both have on a level: the fewer of their two counts. */
const shared = (l: LevelDrivers) => (l.drivers.length >= 2 ? Math.min(l.drivers[0].laps.length, l.drivers[1].laps.length) : 0);

export type LevelPick = {
  both: LevelDrivers[]; // the levels where at least two drivers drove, in the report's order
  all: LevelDrivers | null; // every level at once (allLevels), when it adds something
  // the level compared: the one picked, else where the two drivers have the most laps, else all of them (no level
  // has two drivers)
  level: LevelDrivers | null;
  // the report's own tyre tab is on a level where only one driver drove: who, and on which level (not said on "All")
  only: { tyres: LevelKey; driver: DriverOnLevel } | null;
};

/** The level to compare on: the one picked when two drivers drove there ("All" when it adds something), else the one
 * where the two drivers with the most laps have the most laps both (the highest of the fewer of their two counts; the
 * earlier level on a tie), else all of them: same tyres stay the first choice. */
export function pickLevel(levels: LevelDrivers[], picked: LevelKey | null, shown: TyreLevel | null): LevelPick {
  const both = levels.filter((l) => l.tyres !== ALL && l.drivers.length >= 2);
  const all = allLevels(levels);
  const level = (picked === ALL ? all : both.find((l) => l.tyres === picked))
    ?? both.reduce<LevelDrivers | null>((best, l) => (best == null || shared(l) > shared(best) ? l : best), null)
    ?? all;
  const here = levels.find((l) => l.tyres === shown);
  const only = here && here.drivers.length === 1 && level && level.tyres !== ALL
    ? { tyres: here.tyres, driver: here.drivers[0] } : null;
  return { both, all, level, only };
}

/** The two drivers compared on a level: the two with the most laps, or the two picked when both drove there. */
export function pickPair(level: LevelDrivers, picked: [string, string] | null = null): [DriverOnLevel, DriverOnLevel] {
  const find = (name: string) => level.drivers.find((d) => d.name === name);
  if (picked && picked[0] !== picked[1]) {
    const a = find(picked[0]);
    const b = find(picked[1]);
    if (a && b) return [a, b];
  }
  return [level.drivers[0], level.drivers[1]];
}

/** A new pick of one side: the other side keeps its driver, or the two swap when it is the same one. */
export function repick(pair: [string, string], side: Side, name: string): [string, string] {
  const [a, b] = pair;
  if (side === 'a') return name === b ? [b, a] : [name, b];
  return name === a ? [b, a] : [a, name];
}

/** "PIA 0.40 s quicker", "level" (under half a hundredth): `a` against `b`, as times. */
export function gapWords(a: number, b: number, codes: Record<Side, string>): string {
  const d = Math.round((a - b) * 1000) / 1000;
  if (Math.abs(d) < 0.005) return 'Level';
  return `${d < 0 ? codes.a : codes.b} ${Math.abs(d).toFixed(2)} s quicker`;
}

// ---------- corner by corner ----------

export type Phase = 'braking' | 'trail' | 'mid' | 'exit' | 'power';
export type GroupKey = 'top' | 'median' | 'bottom';
/** The passes a corner is drawn from, as the report names them (its "Top 10%"; the middle of the ranking, the
 * typical pass; the bottom tenth). */
export const GROUPS: { key: GroupKey; label: string; words: string }[] = [
  { key: 'top', label: 'Top 10%', words: 'the top 10% of passes' },
  { key: 'median', label: 'Median', words: 'the typical passes' },
  { key: 'bottom', label: 'Bottom 10%', words: 'the bottom 10% of passes' },
];

/** One driver's group of passes through a corner (GET /report/drivers/corners): the medians of their numbers
 * (positions in metres from the apex, minus before it) and of their speed, brake and throttle every `step_m`. */
export type CornerGroup = {
  passes: number;
  brake_point: number | null;
  brake_off: number | null;
  peak_brake: number | null;
  trail_share: number | null; // 0..1
  min_speed: number | null;
  min_speed_at: number | null;
  gear: number | null;
  throttle_on: number | null;
  full_throttle: number | null;
  exit_speed: number | null;
  time: number | null;
  speed: (number | null)[];
  brake: (number | null)[];
  throttle: (number | null)[];
};

export type DriverCorner = {
  code: string;
  corners: string[];
  apex_m: number;
  flat: boolean; // taken flat: its apex is its official position
  from_m: number; // the traces' first point, from the apex
  step_m: number;
  median: Record<Side, number>;
  delta_s: number; // a minus b, typical passes: + means a is slower
  faster: Side;
  beats: number; // the quicker driver's passes quicker than the other's typical pass
  of: number;
  by_phase: Record<Phase, number | null>;
  main_phase: Phase | null;
  groups: Record<GroupKey, Record<Side, CornerGroup>>;
};

/** A mistake the technique check finds again and again in one driver's laps (GET /report/drivers/flags). */
export type Flag = { kind: string; code: string; title: string; laps: number; of: number; share: number };

export const NEGLIGIBLE_S = 0.03; // a corner whose typical passes are closer than this is folded
export const MAX_DIFFERENCES = 3; // driving differences said under a corner
const FLAG_SHARE = 0.25; // a repeated mistake counts for a driver on this share of their laps, when the other
// driver makes it on fewer than this share of theirs or on half as many of them at most

// The least difference said, as the stint's driver changes are (server/app/analysis/stint_words.py MIN_CHANGE and
// MIN_BRAKE): metres, km/h and pressure in the log's unit.
const LEAST = { brake_point: 3, brake_off: 5, min_speed: 1, throttle_on: 3, full_throttle: 5, exit_speed: 1 };
const LEAST_BRAKE: Record<string, number> = { bar: 2, psi: 30, kpa: 200 };

/** The corner numbers of an official section code: "T2-T5" 2, 3, 4, 5; "T8/T9" 8, 9; "T1" 1. */
export function cornerNumbers(code: string): number[] {
  const out: number[] = [];
  for (const part of code.split('/')) {
    const m = part.match(/^T(\d+)(?:-T?(\d+))?$/i);
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let n = from; n <= to && n - from < 50; n++) out.push(n);
  }
  return out;
}

/** Whether a mistake found at `flagCode` is in the section `code` (the same code, or a corner of it). */
export function inSection(flagCode: string, code: string): boolean {
  if (flagCode === code) return true;
  const mine = new Set(cornerNumbers(code));
  return cornerNumbers(flagCode).some((n) => mine.has(n));
}

const lower = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const whole = (v: number) => Math.round(Math.abs(v)).toString();

/** A position from the apex: "112 m before", "8 m after", "at the apex"; "–" when not measured. */
export function fromApex(v: number | null): string {
  if (v == null) return '–';
  const m = Math.round(v);
  return m === 0 ? 'at the apex' : `${Math.abs(m)} m ${m < 0 ? 'before' : 'after'}`;
}

/** The gear as the logger numbers it: some dashes number gears with an offset (the BMW M4 GT4's logs first gear as 5,
 * prep/guide.py first_gear), so no "2nd" is made of it here. */
export const gearName = (g: number) => `gear ${g}`;

/** The rows of a corner's numbers, the two drivers side by side: braking, the slowest point, the exit, in the order
 * a lap meets them. A row neither driver has (no braking in a corner taken flat) is left out. */
export function numberRows(a: CornerGroup, b: CornerGroup, brakeUnit: string | null, flat: boolean):
  { label: string; a: string; b: string }[] {
  const unit = brakeUnit ? ` ${brakeUnit}` : '';
  const speed = (v: number | null) => (v == null ? '–' : `${v.toFixed(1)} km/h`);
  const rows: { label: string; a: string; b: string; known: boolean }[] = [
    { label: 'Brake point', a: fromApex(a.brake_point), b: fromApex(b.brake_point),
      known: a.brake_point != null || b.brake_point != null },
    { label: 'Peak brake', a: a.peak_brake == null ? '–' : `${a.peak_brake.toFixed(0)}${unit}`,
      b: b.peak_brake == null ? '–' : `${b.peak_brake.toFixed(0)}${unit}`,
      known: a.peak_brake != null || b.peak_brake != null },
    { label: 'Off the brakes', a: fromApex(a.brake_off), b: fromApex(b.brake_off),
      known: a.brake_off != null || b.brake_off != null },
    { label: flat ? 'Speed in the corner' : 'Minimum speed',
      a: `${speed(a.min_speed)}${a.gear != null ? `, ${gearName(a.gear)}` : ''}`,
      b: `${speed(b.min_speed)}${b.gear != null ? `, ${gearName(b.gear)}` : ''}`, known: true },
    { label: 'Slowest point', a: fromApex(a.min_speed_at), b: fromApex(b.min_speed_at), known: !flat },
    { label: 'Throttle on', a: fromApex(a.throttle_on), b: fromApex(b.throttle_on),
      known: a.throttle_on != null || b.throttle_on != null },
    { label: 'Full throttle', a: fromApex(a.full_throttle), b: fromApex(b.full_throttle),
      known: a.full_throttle != null || b.full_throttle != null },
    { label: 'Exit speed', a: speed(a.exit_speed), b: speed(b.exit_speed), known: true },
  ];
  return rows.filter((r) => r.known).map(({ known: _, ...r }) => r);
}

type Said = { side: Side; text: string; weight: number; order: number };

/** The driving differences of a corner in plain words, the biggest (against the least difference said of each) first
 * at most MAX_DIFFERENCES, put back in the order a lap meets them and each driver's joined: "RAC brakes 9 m later
 * and 4 bar harder, PIA carries 3.1 km/h more through the apex". null when the two drive it the same way. */
export function differenceWords(a: CornerGroup, b: CornerGroup, codes: Record<Side, string>,
  brakeUnit: string | null = null, flat = false): string | null {
  const said: Said[] = [];
  const add = (va: number | null, vb: number | null, least: number, order: number,
    words: (who: Side, d: number) => string, higherSays = true) => {
    if (va == null || vb == null) return;
    const d = va - vb;
    if (Math.abs(d) < least - 1e-9) return;
    const who: Side = (d > 0) === higherSays ? 'a' : 'b';
    said.push({ side: who, text: words(who, d), weight: Math.abs(d) / least, order });
  };
  const leastBrake = LEAST_BRAKE[(brakeUnit ?? '').toLowerCase()] ?? 2;
  const unit = brakeUnit ? ` ${brakeUnit}` : '';
  add(a.brake_point, b.brake_point, LEAST.brake_point, 0, (_, d) => `brakes ${whole(d)} m later`);
  add(a.peak_brake, b.peak_brake, leastBrake, 1, (_, d) => `${whole(d)}${unit} harder`);
  add(a.brake_off, b.brake_off, LEAST.brake_off, 2, (_, d) => `stays on the brakes ${whole(d)} m longer`);
  add(a.min_speed, b.min_speed, LEAST.min_speed, 3,
    (_, d) => `carries ${Math.abs(d).toFixed(1)} km/h more ${flat ? 'through the corner' : 'at the apex'}`);
  add(a.throttle_on, b.throttle_on, LEAST.throttle_on, 4, (_, d) => `picks up the throttle ${whole(d)} m earlier`,
    false);
  add(a.full_throttle, b.full_throttle, LEAST.full_throttle, 5, (_, d) => `is flat out ${whole(d)} m earlier`, false);
  add(a.exit_speed, b.exit_speed, LEAST.exit_speed, 6, (_, d) => `exits ${Math.abs(d).toFixed(1)} km/h faster`);
  if (!said.length) return null;
  const kept = [...said].sort((x, y) => y.weight - x.weight).slice(0, MAX_DIFFERENCES).sort((x, y) => x.order - y.order);
  const parts: string[] = [];
  for (const side of [...new Set(kept.map((k) => k.side))]) {
    const mine = kept.filter((k) => k.side === side);
    let words = mine.map((k) => k.text);
    // "brakes 9 m later and 4 bar harder"; a harder stop alone: "brakes 4 bar harder"
    words = words.map((w, i) => (mine[i].order === 1 && mine[i - 1]?.order !== 0 ? `brakes ${w}` : w));
    parts.push(`${codes[side]} ${words.join(' and ')}`);
  }
  return parts.join(', ');
}

const PHASE_WORDS: Record<Phase, string> = {
  braking: 'under braking', trail: 'turning in', mid: 'mid-corner', exit: 'on the exit', power: 'on the way out',
};

/** The corner's time, second to how it is driven: "PIA 0.23 s quicker here (typical passes), on 29 of 29 laps, most
 * of it mid-corner"; "Level here (typical passes)" under half a hundredth. */
export function gapLine(c: DriverCorner, codes: Record<Side, string>): string {
  const d = Math.abs(c.delta_s);
  if (d < 0.005) return 'Level here (typical passes)';
  const most = c.main_phase ? `, most of it ${PHASE_WORDS[c.main_phase]}` : '';
  return `${codes[c.faster]} ${d.toFixed(2)} s quicker here (typical passes), on ${c.beats} of ${c.of} laps${most}`;
}

/** The corners in the order shown: the biggest gap between the typical passes first; those closer than NEGLIGIBLE_S
 * folded, in lap order. */
export function cornerOrder(corners: DriverCorner[]): { shown: DriverCorner[]; folded: DriverCorner[] } {
  const shown = corners.filter((c) => Math.abs(c.delta_s) >= NEGLIGIBLE_S)
    .sort((x, y) => Math.abs(y.delta_s) - Math.abs(x.delta_s));
  return { shown, folded: corners.filter((c) => Math.abs(c.delta_s) < NEGLIGIBLE_S) };
}

/** The mistakes the technique check finds in this section for one driver of the two (on a quarter or more of their
 * laps, and on under a quarter of the other's or half as many at most), as lines, the most frequent first:
 * "RAC: lifting on the way out on 12 of 32 laps, PIA on 5 of 29 (technique check)". */
export function checkLines(code: string, flags: Record<Side, Flag[]> | null, codes: Record<Side, string>): string[] {
  if (!flags) return [];
  const out: { side: Side; kind: string; share: number; text: string }[] = [];
  for (const side of SIDES) {
    const other: Side = side === 'a' ? 'b' : 'a';
    for (const f of flags[side]) {
      if (!inSection(f.code, code) || f.share < FLAG_SHARE) continue;
      const theirs = flags[other].find((g) => g.kind === f.kind && inSection(g.code, code));
      if (theirs && theirs.share >= FLAG_SHARE && theirs.share > f.share / 2) continue;
      if (out.some((o) => o.side === side && o.kind === f.kind)) continue;
      const also = theirs ? `, ${codes[other]} on ${theirs.laps} of ${theirs.of}` : '';
      out.push({ side, kind: f.kind, share: f.share,
        text: `${codes[side]}: ${lower(f.title)} on ${f.laps} of ${f.of} laps${also} (technique check)` });
    }
  }
  return out.sort((x, y) => y.share - x.share).map((o) => o.text);
}

/** What the two were compared on, in a line or two: the tyres, the sessions both drove (or that they drove in
 * different ones: the track can differ), the laps of each, how the passes are ranked, the runs left out. */
export type Matched = {
  same_sessions: boolean;
  parts: string[];
  by_side: Record<Side, string[]>;
  runs: Record<Side, number[]>;
  left_out: { session_id: number; name: string; side: Side }[];
};

const list = (v: string[]) => (v.length < 2 ? v.join('') : `${v.slice(0, -1).join(', ')} and ${v.at(-1)}`);

/** `mix`: on "All" tyres, the levels each side's laps were on (sideTyres): said, and when they differ, what that
 * means for the numbers. */
export function matchedLines(m: Matched, tyres: string, laps: Record<Side, number>, names: Record<Side, string>,
  mix: Record<Side, TyreLevel[]> | null = null): string[] {
  const where = m.same_sessions ? ` in ${list(m.parts)}, where both drove` : '';
  const what = mix ? 'All tyres' : `Like with like: ${tyres.toLowerCase()} tyres`;
  const out = [`${what}, clean laps${where} (${laps.a} of ${names.a}'s, ` +
    `${laps.b} of ${names.b}'s); each corner's passes ranked against the laps either side in the same stint.`];
  if (mix) {
    const on = (side: Side) => list(mix[side].map((t) => TYRE_WORDS[t].toLowerCase()));
    const same = mix.a.join() === mix.b.join();
    out.push(same ? `Both on ${on('a')} tyres.`
      : `Not like with like on tyres: ${names.a}'s laps on ${on('a')} tyres, ${names.b}'s on ${on('b')}. The lap ` +
        'times are put on one tyre age and fuel load where each set\'s age is known; the corners are as driven, so ' +
        'newer tyres can show as more grip.');
  }
  if (!m.same_sessions) {
    out.push(`${names.a}'s laps are from ${list(m.by_side.a)}, ${names.b}'s from ${list(m.by_side.b)}: the track ` +
      'can differ.');
  }
  for (const side of SIDES) {
    const parts = [...new Set(m.left_out.filter((l) => l.side === side).map((l) => l.name))];
    if (parts.length) out.push(`Left out: ${names[side]}'s ${list(parts)}, where only ${names[side]} drove.`);
  }
  return out;
}

/** Each driver's laps as the server put them on one tyre age and fuel load. */
export type SideLaps = {
  label: string;
  laps: number;
  runs: number[];
  best: DriverLap;
  typical: DriverLap;
  typical_corrected: DriverLap & { corrected: number };
  tyre_age: number | null;
  fuel_kg: number | null;
};

export type DriversCorners = {
  track: string | null;
  labels: Record<Side, string>;
  numbering: 'official' | 'detected';
  brake_unit: string | null;
  sides: Record<Side, SideLaps>;
  gap: { best: number; typical: number; typical_corrected: number };
  correction: { tyres: boolean; fuel: boolean; words: string[]; fade_s_per_lap: number | null;
    fade_source: 'stints' | 'track' | null; tyre_age: number | null; kg_per_lap: number | null;
    s_per_10kg: number | null; fuel_source: 'log' | 'estimate' | null };
  corners: DriverCorner[];
  matched: Matched;
};

// ---------- balance ----------

export type BalancePhase = 'entry' | 'mid' | 'exit';
export const BALANCE_PHASES: BalancePhase[] = ['entry', 'mid', 'exit'];
export type BalanceCell = { value: number; kind: 'understeer' | 'oversteer' | 'normal';
  strength: 'slight' | 'clear' | 'strong' | null; laps?: number };
/** One section of GET /report/drivers/balance: each side's balance on entry, mid-corner and exit. */
export type BalanceSection = { code: string; corners?: string[] } & Record<Side, Record<BalancePhase, BalanceCell | null>>;

export const BALANCE_DIFF_DEG = 0.5; // two balances this far apart, that read differently, differ
export const PHASE_LABEL: Record<BalancePhase, string> = { entry: 'entry', mid: 'mid', exit: 'exit' };

/** "strong understeer", "slight oversteer", "neutral". */
export const balanceWord = (c: Pick<BalanceCell, 'kind' | 'strength'>) =>
  c.kind === 'normal' || c.strength == null ? 'neutral' : `${c.strength} ${c.kind}`;

export type BalanceDiff = { code: string; phases: BalancePhase[]; most: number; line: string };

/** The sections where the drivers' balance differs (both measured in a phase, read differently and at least
 * BALANCE_DIFF_DEG apart), the biggest difference first, each with one line: "T6-T7 mid: PIA slight understeer, RAC
 * strong understeer". The others are the same for both (or not measured for both). */
export function balanceDiffs(sections: BalanceSection[], codes: Record<Side, string>):
  { differ: BalanceDiff[]; same: string[] } {
  const differ: BalanceDiff[] = [];
  const same: string[] = [];
  for (const s of sections) {
    const phases = BALANCE_PHASES.filter((p) => {
      const a = s.a[p];
      const b = s.b[p];
      return a != null && b != null && balanceWord(a) !== balanceWord(b) && Math.abs(a.value - b.value) >= BALANCE_DIFF_DEG;
    });
    if (!phases.length) {
      if (BALANCE_PHASES.some((p) => s.a[p] != null && s.b[p] != null)) same.push(s.code);
      continue;
    }
    const parts = phases.map((p) => `${PHASE_LABEL[p]}: ${codes.a} ${balanceWord(s.a[p]!)}, ${codes.b} ${balanceWord(s.b[p]!)}`);
    differ.push({ code: s.code, phases, most: Math.max(...phases.map((p) => Math.abs(s.a[p]!.value - s.b[p]!.value))),
      line: `${s.code} ${parts.join('; ')}` });
  }
  differ.sort((x, y) => y.most - x.most);
  return { differ, same };
}

/** The balance section of a corner of the comparison: the same code, else the one sharing its corners. */
export function balanceFor(sections: BalanceSection[], code: string): BalanceSection | null {
  return sections.find((s) => s.code === code)
    ?? sections.find((s) => cornerNumbers(s.code).some((n) => cornerNumbers(code).includes(n))) ?? null;
}

/** A corner's balance rows for its numbers, the two drivers side by side ("Balance mid": "slight understeer",
 * "neutral"); a phase neither was measured in is left out. */
export function balanceRows(s: BalanceSection | null): { label: string; a: string; b: string }[] {
  if (!s) return [];
  const word = (c: BalanceCell | null) => (c ? balanceWord(c) : '–');
  return BALANCE_PHASES.filter((p) => s.a[p] != null || s.b[p] != null)
    .map((p) => ({ label: `Balance ${p === 'mid' ? 'mid-corner' : `on ${p}`}`, a: word(s.a[p]), b: word(s.b[p]) }));
}

// ---------- grip use ----------

export type GripPhase = 'braking' | 'trail' | 'mid' | 'exit';
export const GRIP_PHASES: GripPhase[] = ['braking', 'trail', 'mid', 'exit'];
/** A lap of the report's grip use (GET /report/grip, lib/grip.ts GripLap), what is read of it here. */
export type GripLapRow = { run: string; lap: number; grip_use: number | null; phases: Record<GripPhase, number | null> };
export type DriverGrip = { laps: number; grip_use: number | null; phases: Record<GripPhase, number | null> };

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Each side's grip use, the median over their laps the grip report has (by run name: `runOf` gives a run name's id)
 * among `runs` of that side; null for a side with no such lap. */
export function gripBySide(laps: GripLapRow[], runOf: (run: string) => number | null | undefined,
  runs: Record<Side, number[]>): Record<Side, DriverGrip | null> {
  const out = {} as Record<Side, DriverGrip | null>;
  for (const side of SIDES) {
    const mine = laps.filter((l) => {
      const id = runOf(l.run);
      return id != null && runs[side].includes(id);
    });
    const num = (v: (number | null)[]) => median(v.filter((x): x is number => x != null));
    out[side] = mine.length ? { laps: mine.length, grip_use: num(mine.map((l) => l.grip_use)),
      phases: Object.fromEntries(GRIP_PHASES.map((p) => [p, num(mine.map((l) => l.phases[p]))])) as DriverGrip['phases'] }
      : null;
  }
  return out;
}

// ---------- the traces ----------

export type TraceKind = 'best' | 'typical';
/** A lap that can go on the traces: a driver's best or typical lap, with the colour slot it keeps. */
export type TraceLap = DriverLap & { key: string; side: Side; kind: TraceKind; slot: number; also: TraceKind | null };

/** The laps on offer for the traces: each driver's best lap (slots 0 and 1, on at first) and typical lap (slots 2
 * and 3); a typical lap that is the best lap itself is the same entry (also: "typical"). */
export function traceLaps(sides: Record<Side, { best: DriverLap; typical: DriverLap }>): TraceLap[] {
  const out: TraceLap[] = [];
  SIDES.forEach((side, i) => {
    const { best, typical: typ } = sides[side];
    const same = best.session_id === typ.session_id && best.lap === typ.lap;
    out.push({ ...best, key: `${side}:best`, side, kind: 'best', slot: i, also: same ? 'typical' : null });
    if (!same) out.push({ ...typ, key: `${side}:typical`, side, kind: 'typical', slot: i + 2, also: null });
  });
  return out;
}

export const DEFAULT_TRACES = ['a:best', 'b:best'];

/** The laps on the traces in a fixed order (the offer's), for the lap comparison. */
export const onTraces = (offer: TraceLap[], keys: string[]) => offer.filter((l) => keys.includes(l.key));

/** A lap's × or its add: off the traces when it is on them, else on them. */
export const flipTrace = (keys: string[], key: string) =>
  (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);
