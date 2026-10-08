// Client for the prep report (GET /prep/events/{id}): every past event at the venue with the same car, worked out
// by the server in the background into a briefing for the coming weekend; GET /prep/events lists the events that have
// past data (for the button), GET /prep/events/{id}/weather the weather then and the forecast now.
import { apiFetch } from '@/lib/api';
import { PrepTrackGrip } from '@/lib/trackGrip';

export type PrepStatus = 'ready' | 'queued' | 'running' | 'failed' | 'none';

export type BriefItem = { key: string; title: string; text: string };

export type LapRef = { time: number; session: string; session_id?: number; driver: string | null };

export type PerfRow = {
  event_id: number;
  name: string;
  year: string;
  start: string | null;
  end: string | null;
  sessions: number;
  clean_laps: number;
  other_cars: boolean;
  best: LapRef;
  typical: number | null;
  quali: (LapRef & { basis: 'qualifying' | 'quali run'; lap?: number }) | null;
  race_pace: { time: number; laps: number; basis: 'race' | 'long runs' } | null;
  drivers: { name: string; best: number; laps: number }[];
  conditions: { ambient_c: [number, number] | null; track_c: [number, number] | null; tyres: string[] };
  change: { best?: number; race_pace?: number; quali?: number } | null;
};

export type CornerRow = {
  code: string;
  corners: string[];
  flat: boolean;
  gain_s: number | null;
  main_phase: string | null;
  year: string;
  best: number | null;
  best_by: { session: string | null; driver: string | null };
  per_event: Record<string, { year: string; best: number | null; typical: number | null;
    gain: number | null; main_phase: string | null }>;
  top_in: string[];
  change: { typical: number; best: number; from: string; to: string } | null;
  ideal: string | null; // what the quick passes did, in one sentence
  why: string | null;
  advice: string[];
  drivers: { driver: string | null; text: string }[];
};

export type QualiEvent = {
  event_id: number;
  year: string;
  quali: PerfRow['quali'];
  push: { front_c: number; rear_c: number } | null;
  ready_min: [number, number] | null;
  peak_from_exit: [number, number] | null;
  warm_up: { label: string; warm_laps: number | null; drag_s: number | null; straight_hard_stops: number | null;
    weaves: number | null; ready_min: number | null; peak_flying: number | null; peak_time: number | null } | null;
  cold: Record<string, number> | null;
  sims: number;
};

export type SetupRun = {
  event_id: number;
  year: string;
  session_id: number;
  name: string;
  driver: string | null;
  best: number | null;
  top3: number | null;
  setup: boolean;
  changes: string[];
  compared_with: string | null;
  delta_best: number | null;
  balance: string | null;
  tc_s_per_lap: number | null;
  remarks: { text: string; verdict: string | null; data: string | null }[];
};

export type PrepReport = {
  target: { id: number; name: string };
  car: { key: string; label: string };
  briefing: BriefItem[];
  performance: PerfRow[];
  trend: string | null;
  corners: { rows: CornerRow[]; comparable: boolean; note: string | null; from: string | null; changes: string | null };
  quali: { from: string; event_id: number; advice: BriefItem[]; per_event: QualiEvent[] } | null;
  pressures: {
    year?: string;
    tyres?: { tyre: string; cold_bar: number | null; target_hot_bar: number; runs: number | null }[];
    ambient_c?: [number, number] | null;
    tyre_model: { track: string | null; sessions: number; laps: number; lines: string[] } | null;
  } | null;
  setups: { runs: SetupRun[]; said: { label: string; text: string; years: string[] }[]; with_sheet: number;
    note: string | null };
  technique: { name: string | null; laps: number; years: string[];
    habits: { code: string; phase: string; title: string; text: string; cost_per_lap_s: number }[] }[];
  track_grip?: PrepTrackGrip | null; // reports kept before it existed lack it
  notes: string[];
  method: string[];
};

export type CarChoice = { key: string; label: string; events: number; sessions: number; latest: string | null };

export type PrepAnswer = {
  event: { id: number; name: string; series: string | null; start: string | null; end: string | null;
    track: string | null; sessions: number; upcoming: boolean };
  car: { key: string; label: string };
  cars: CarChoice[];
  past_events: { id: number; name: string; start: string | null; end: string | null; sessions: number }[];
  status: PrepStatus;
  reason: string | null;
  progress: { done: number; total: number; current: string | null } | null;
  error: string | null;
  stale: boolean;
  report: PrepReport | null;
};

export type WeatherDay = { date: string; t_max: number | null; t_min: number | null; rain_mm: number | null;
  rain_chance: number | null; wind_kmh: number | null; sky: string | null };
export type WeatherSummary = { t_max: number; t_min: number | null; t_max_mean: number; rain_mm: number | null;
  wet_days: number; days: number; rain_chance: number | null; wind_kmh: number | null; text: string };
export type PrepWeather = {
  place: { lat: number; lon: number; track: string } | null;
  past: { event_id: number; year: string | null; days: WeatherDay[]; summary: WeatherSummary | null }[];
  forecast: { kind: 'forecast' | 'actual'; days: WeatherDay[]; summary: WeatherSummary | null } | null;
  note: string | null;
  compare: string | null;
};

// the official series results at the track (server/app/prep/official.py), read live
export type OfficialWeather = { air_c: number | null; track_c: number | null; conditions: string | null;
  conditions_end?: string | null };
export type OfficialWeatherRow = OfficialWeather & { code: string; dry: boolean };
export type OfficialSessionRow = {
  code: string; title: string; dry: boolean; cars: number; place: string; position: number | null;
  class_position: number | null; class_cars: number | null; car_class: string | null; best_lap_s: number | null;
  fastest_s: number | null; to_fastest_pct: number | null; starts_at: string | null; weather: OfficialWeather;
};
export type OfficialMake = { brand: string; cars: number; best_s: number | null; best_car: string | null;
  to_fastest_pct: number | null; median_s: number | null; best_position: number | null; ours: boolean };
export type PredictedQuali = { pole_s: number | null; pole_range_s: [number, number] | null;
  our_time_s: number | null; our_time_range_s: [number, number] | null; our_gap_pct: number | null;
  position: number | null; position_range: [number, number] | null; class_position: number | null;
  class_position_range: [number, number] | null; field_size: number | null; class_size: number | null };
export type PredictedRace = { grid_from: string; position: number | null; position_range: [number, number] | null;
  usual_gain: number | null };
export type PrepOfficial = {
  series: string;
  venue: string | null;
  track: string | null;
  year: number;
  car_number: string | null;
  car_number_from: string | null;
  team: string | null;
  brand: string | null;
  loaded: boolean;
  years: { year: number; name: string; round: number; sessions: OfficialSessionRow[] }[];
  lines: string[];
  track_verdict: { verdict: 'strong' | 'average' | 'weak' | null; offset_pct: number | null; visits: number;
    avg_quali_pos: number | null; avg_race_pos: number | null; text: string | null; strongest: string[];
    weakest: string[] } | null;
  makes: { year: number; code: string; rows: OfficialMake[]; makes: number; text: string | null } | null;
  weather: Record<string, OfficialWeatherRow[]>; // per past event id: its official sessions' weather
  prediction: {
    venue_name: string;
    year: number;
    team: string | null;
    brand: string | null;
    car_class: string | null;
    sessions: { Q1?: PredictedQuali; Q2?: PredictedQuali; R1?: PredictedRace; R2?: PredictedRace };
    explain: string[];
    notes: string[];
    line: string | null;
    logged_best: { time_s: number; event: string } | null;
  } | null;
  trust: { years: number[]; summary: string[]; text: string | null } | null;
  note: string | null;
};

// per event id: how many past events at its venue, of which years
export type PrepAvailability = Record<string, { events: number; same_car_events: number; years: string[];
  upcoming: boolean }>;

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json();
}

const carQuery = (car?: string | null) => (car ? `?car=${encodeURIComponent(car)}` : '');

export const fetchPrep = (event: number, car?: string | null) =>
  getJson<PrepAnswer>(`/prep/events/${event}${carQuery(car)}`);
export const refreshPrep = (event: number, car?: string | null) =>
  getJson<PrepAnswer>(`/prep/events/${event}/refresh${carQuery(car)}`, { method: 'POST' });
export const fetchPrepWeather = (event: number) => getJson<PrepWeather>(`/prep/events/${event}/weather`);
export const fetchPrepOfficial = (event: number, car?: string | null) =>
  getJson<PrepOfficial>(`/prep/events/${event}/results${carQuery(car)}`);
export const fetchPrepAvailability = async (): Promise<PrepAvailability> =>
  (await getJson<{ events: PrepAvailability }>('/prep/events')).events;

/** "2 past events: 2025, 2026" for a button's caption. */
export const pastCaption = (a: PrepAvailability[string]) =>
  `${a.events} past ${a.events === 1 ? 'event' : 'events'}${a.years.length ? `: ${a.years.join(', ')}` : ''}`;
