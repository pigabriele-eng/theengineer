// Client for the official results (server/app/routers/results.py): the series' timing sheets for an event's round,
// which car is ours, where we finished in each official session, and the official session a logged run belongs to.
import { apiFetch } from '@/lib/api';

export type SyncState = {
  running: boolean;
  what: string | null; // what is being fetched now
  done: number;
  total: number;
  errors: string[];
  finished_at: string | null;
};

export type ResultStatus = 'classified' | 'nc' | 'dns' | 'dnf' | 'dsq';

export type OurResult = {
  position: number | null;
  status: ResultStatus;
  car_number: string;
  drivers: string[];
  team: string;
  car_class: string; // "Silver", "Pro-Am", "Am"
  car_model: string;
  brand: string;
  laps: number;
  best_lap_s: number | null;
  total_time_s: number | null;
  gap_s: number | null;
  gap_laps: number | null;
  diff_s: number | null;
  class_position: number | null;
  class_cars: number | null;
  gap_to_leader_s: number | null;
  gap_to_leader_laps: number | null;
  gap_to_ahead_s: number | null;
  best_lap_rank: number | null;
  to_fastest_s: number | null;
  to_fastest_pct: number | null;
  class_best_s: number | null;
  to_class_best_s: number | null;
  brand_best_s: number | null; // the quickest other car of our make
  brand_best_car: string | null;
};

export type BrandRow = {
  brand: string;
  cars: number;
  best_s: number | null;
  best_car: string | null;
  to_fastest_pct: number | null;
  median_s: number | null;
  best_position: number | null;
};

export type Weather = {
  air_c_start?: number | null;
  track_c_start?: number | null;
  conditions_start?: string | null;
  air_c_end?: number | null;
  track_c_end?: number | null;
  conditions_end?: string | null;
};

export type OfficialSession = {
  id: number;
  code: string; // "Q1", "R2"
  title: string; // "Qualifying 1"
  kind: 'qualifying' | 'race';
  starts_at: string | null; // local time at the track, ISO without zone
  weather: Weather;
  fastest: string;
  source_url: string; // the official PDF
  cars: number;
  fetched_at: string;
  fastest_s: number | null;
  fastest_car: string | null; // "#8 Audi"
  logged_best_s?: number | null; // our logged best lap in that session
  logged_rank?: number | null; // where it would have placed among the session's best laps
  us: OurResult | null;
  our_sessions: { id: number; name: string }[];
  brands: BrandRow[];
};

export type ResultsRound = { year: number; round: number; round_id: string; name: string; fetched_at: string };

export type EventResults = {
  event_id: number;
  series: string; // "gt4-europe"
  year: number;
  venue: string | null;
  track: string | null;
  round: ResultsRound | null;
  car_number: string | null;
  car_number_from: string | null; // "set", or "logged laps (3 matching)"
  note?: string | null;
  sync: SyncState;
  sessions: OfficialSession[];
};

export type ResultsStatus = {
  sync: SyncState;
  sources: { series: string; name: string }[];
  loaded: { series: string; year: number; sessions: number }[];
};

export type RunResult = {
  session_id: number;
  event_id?: number | null;
  round: ResultsRound | null;
  car_number: string | null;
  car_number_from: string | null;
  official: OfficialSession | null;
  note?: string | null;
};

export type ResultsLink = { car_number?: string; year?: number; round_id?: string };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const resultsApi = {
  event: (eventId: number) => call<EventResults>(`/results/events/${eventId}`),
  // starts fetching the round's sheets in the background; follow it with status
  fetch: (eventId: number) =>
    call<{ started: boolean; sync: SyncState }>(`/results/events/${eventId}/fetch`, { method: 'POST' }),
  status: () => call<ResultsStatus>('/results/status'),
  // which car is ours (and which round, if the automatic match is wrong); {} goes back to automatic matching
  link: (eventId: number, body: ResultsLink) =>
    call<EventResults>(`/results/events/${eventId}/link`, send('PUT', body)),
  run: (sessionId: number) => call<RunResult>(`/results/runs/${sessionId}`),
};

// ---------- wording ----------

const SERIES_NAMES: Record<string, string> = {
  'gt4-europe': 'GT4 European Series',
  'adac-gt4-germany': 'ADAC GT4 Germany',
};
export const seriesName = (s: string) => SERIES_NAMES[s] ?? s;

/** "GT4 European Series 2026, round 5 (Zandvoort)". */
export function roundTitle(r: EventResults) {
  const where = r.round?.name ?? r.track ?? r.venue;
  const base = `${seriesName(r.series)} ${r.round?.year ?? r.year}`;
  return r.round ? `${base}, round ${r.round.round}${where ? ` (${where})` : ''}` : base;
}

export const STATUS_NAMES: Record<ResultStatus, string> = {
  classified: 'Classified',
  nc: 'Not classified',
  dns: 'Did not start',
  dnf: 'Did not finish',
  dsq: 'Disqualified',
};

/** "+0.294 s": gaps stay in seconds. */
export const plusSeconds = (s: number | null | undefined, digits = 3) =>
  s == null ? null : `${s >= 0 ? '+' : '−'}${Math.abs(s).toFixed(digits)} s`;

/** A gap in a race: "+29.1 s", or "+2 laps" when lapped. */
export function raceGap(s: number | null | undefined, laps: number | null | undefined) {
  if (laps != null && laps > 0) return `+${laps} lap${laps === 1 ? '' : 's'}`;
  return s == null ? null : `+${s.toFixed(1)} s`;
}

export const percent = (p: number | null | undefined) =>
  p == null ? null : `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(2)} %`;

/** "Sat 11:15" from the local start time. */
export function startLabel(iso: string | null) {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const wd = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd]} ${m[4]}:${m[5]}`;
}

/** "Air 18 °C, track 24 °C, dry", with how it ended when it changed. */
export function weatherLabel(w: Weather) {
  const part = (air?: number | null, track?: number | null, cond?: string | null) =>
    [air != null ? `air ${Math.round(air)} °C` : null, track != null ? `track ${Math.round(track)} °C` : null,
      cond ? cond.toLowerCase() : null].filter(Boolean).join(', ');
  const start = part(w.air_c_start, w.track_c_start, w.conditions_start);
  const end = part(w.air_c_end, w.track_c_end, w.conditions_end);
  const text = start && end && end !== start ? `${start}; at the end ${end}` : start || end;
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
}
