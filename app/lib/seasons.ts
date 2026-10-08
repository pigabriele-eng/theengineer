// Seasons made ahead, what each event was run with (event info) and the garage's vehicle and tyre lists
// (server/app/seasons.py and server/app/catalog.py), and the series' calendars and entry lists the Seasons screen
// fills a season from (server/app/routers/results.py; a server without them gives a manual season).
import { apiFetch } from '@/lib/api';

export type Axle = { front?: number | null; rear?: number | null };
export type TyreSpecs = {
  cold_min_bar?: Axle;
  hot_min_bar?: Axle;
  hot_target_bar?: Axle;
  source?: string | null;
};

export type Vehicle = {
  id: number;
  name: string; // "BMW M4 GT4 Evo (G82)"
  maker: string | null;
  car_class: string | null;
  specs: Record<string, unknown>;
  notes: string | null;
  car_ids?: number[]; // the garage cars that are this vehicle
};

export type Tyre = {
  id: number;
  brand: string;
  compound: string;
  label: string; // "Pirelli P Zero DHG"
  size: string | null;
  specs: TyreSpecs;
  notes: string | null;
};

export type VehicleFields = { name?: string; maker?: string | null; car_class?: string | null; notes?: string | null };
export type TyreFields = { brand?: string; compound?: string; size?: string | null; specs?: TyreSpecs; notes?: string | null };

// Our entry for a season: car, team, vehicle, tyre and drivers 1 to 4 (garage ids).
export type Entry = {
  car_id: number | null;
  team_id: number | null;
  vehicle_model_id: number | null;
  tyre_kind_id: number | null;
  drivers: number[];
};

export const EMPTY_ENTRY: Entry = { car_id: null, team_id: null, vehicle_model_id: null, tyre_kind_id: null, drivers: [] };

export type SeasonRound = {
  id: number;
  order: number;
  name: string;
  venue: string | null;
  start: string | null;
  end: string | null;
  round_id: string | null; // the series site's id; null for a round typed in
  event_id: number | null;
  event_name: string | null;
  has_data: boolean;
  plan_id: number | null;
  made_event: boolean;
};

export type Season = {
  id: number;
  name: string;
  series: string | null; // the results key ("gt4-europe"); null: made by hand
  year: number;
  car_number: string | null;
  entry: Entry;
  created_at: string | null;
  rounds: SeasonRound[];
  events_removed?: number;
  filled?: string[];
};

export type RoundFields = {
  name: string;
  venue?: string | null;
  start?: string | null;
  end?: string | null;
  round_id?: string | null;
  order?: number | null;
};

export type SeasonFields = {
  name?: string;
  series?: string | null;
  year?: number;
  car_number?: string | null;
  entry?: Entry;
  rounds?: RoundFields[];
};

// The checklist's keys, in the order the server sends them.
export type MissingKey = 'tyre brand' | 'compound' | 'car' | 'team' | 'drivers';

export type InfoSource = 'event' | 'season' | 'runs' | 'car' | null;
export type InfoIds = Entry; // the same fields, by id

export type EventInfo = {
  event_id: number;
  event_name: string | null;
  resolved: {
    tyre_kind: Tyre | null;
    car: { id: number; name: string; number: string | null; model: string | null } | null;
    team: { id: number; name: string } | null;
    vehicle_model: Vehicle | null;
    drivers: { id: number; name: string }[];
  };
  from: { tyre_kind: InfoSource; car: InfoSource; team: InfoSource; vehicle_model: InfoSource; drivers: InfoSource };
  own: InfoIds & { season_id: number | null };
  season: {
    id: number;
    name: string;
    series: string | null;
    year: number;
    car_number: string | null;
    entry: Entry;
    round: { id: number; order: number; name: string } | null;
  } | null;
  missing: MissingKey[];
  // what the previous event of the same car was run with, to fill the form from
  previous?: (InfoIds & { event_id: number; event_name: string }) | null;
};

// The series' site, as the results module reads it
export type Series = { key: string; name: string; years: number[] };
export type CalendarRound = {
  round_id: string;
  name: string;
  venue: string | null; // a venue key, e.g. "paul-ricard"
  order: number;
  start: string | null;
  end: string | null;
  entries: number; // cars on its entry list, 0 until it is published
  entry_list_url?: string | null;
};
export type SeriesCalendar = {
  series: string;
  year: number;
  status: 'syncing' | 'loaded' | 'not loaded';
  sync?: { running?: boolean; errors?: string[] } & Record<string, unknown>;
  fetched_at: string | null;
  rounds: CalendarRound[];
};
export type EntryRow = {
  car_number: string;
  drivers: string[];
  team: string | null;
  car_model: string | null;
  brand: string | null;
  car_class: string | null;
};

export class NotThere extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail) ? body.detail.map((d: { msg: string }) => d.msg).join('; ') : body.detail;
    const message = typeof detail === 'string' ? detail : `Request failed (${res.status})`;
    throw res.status === 404 ? new NotThere(message) : new Error(message);
  }
  return (res.status === 204 ? undefined : res.json()) as Promise<T>;
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const catalogApi = {
  vehicles: () => call<Vehicle[]>('/catalog/vehicles'),
  addVehicle: (body: VehicleFields) => call<Vehicle>('/catalog/vehicles', send('POST', body)),
  updateVehicle: (id: number, body: VehicleFields) => call<Vehicle>(`/catalog/vehicles/${id}`, send('PUT', body)),
  removeVehicle: (id: number) => call<void>(`/catalog/vehicles/${id}`, { method: 'DELETE' }),
  tyres: () => call<Tyre[]>('/catalog/tyres'),
  addTyre: (body: TyreFields) => call<Tyre>('/catalog/tyres', send('POST', body)),
  updateTyre: (id: number, body: TyreFields) => call<Tyre>(`/catalog/tyres/${id}`, send('PUT', body)),
  removeTyre: (id: number) => call<void>(`/catalog/tyres/${id}`, { method: 'DELETE' }),
  setCarVehicle: (carId: number, vehicleId: number | null) =>
    call<{ car_id: number; vehicle_model_id: number | null }>(`/catalog/cars/${carId}/vehicle`,
      send('PUT', { vehicle_model_id: vehicleId })),
};

export const seasonsApi = {
  list: () => call<Season[]>('/seasons'),
  get: (id: number) => call<Season>(`/seasons/${id}`),
  create: (body: SeasonFields) => call<Season>('/seasons', send('POST', body)),
  update: (id: number, body: SeasonFields) => call<Season>(`/seasons/${id}`, send('PUT', body)),
  remove: (id: number) => call<{ deleted: number; events_removed: number }>(`/seasons/${id}`, { method: 'DELETE' }),
  fillEntry: (id: number, row: EntryRow) => call<Season>(`/seasons/${id}/fill-entry`, send('POST', row)),
  info: (eventId: number) => call<EventInfo>(`/events/${eventId}/info`),
};

// The series' site through the results module. A server without it answers 404 (NotThere): the season is then
// made by hand.
export const seriesApi = {
  series: () => call<Series[]>('/results/series'),
  sync: (series: string, year: number) =>
    call<{ started: boolean }>(`/results/calendar/sync?series=${encodeURIComponent(series)}&year=${year}`,
      { method: 'POST' }),
  calendar: (series: string, year: number) =>
    call<SeriesCalendar>(`/results/calendar?series=${encodeURIComponent(series)}&year=${year}`),
  entries: (series: string, year: number, roundId: string) =>
    call<EntryRow[]>(`/results/entries?series=${encodeURIComponent(series)}&year=${year}&round_id=${encodeURIComponent(roundId)}`),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 2000;
const MAX_WAIT_MS = 180_000;

/** The series' calendar for the year, read from its site now: the sync runs in the background on the server, and
 * the calendar is asked for again while it does. */
export async function readCalendar(series: string, year: number, onStep?: (text: string) => void): Promise<SeriesCalendar> {
  onStep?.('Reading the calendar from the series’ site…');
  await seriesApi.sync(series, year);
  const until = Date.now() + MAX_WAIT_MS;
  let cal = await seriesApi.calendar(series, year);
  while (cal.status === 'syncing' && Date.now() < until) {
    await sleep(POLL_MS);
    cal = await seriesApi.calendar(series, year);
  }
  return cal;
}

/** The calendar's rounds as the season's rounds. */
export const roundsFrom = (cal: SeriesCalendar): RoundFields[] =>
  cal.rounds.map((r) => ({ name: r.name, venue: r.name || r.venue, start: r.start, end: r.end, round_id: r.round_id,
    order: r.order }));

/** Our car's row on the latest published entry list of the season, if any. */
export async function ourEntry(series: string, year: number, cal: SeriesCalendar, carNumber: string): Promise<EntryRow | null> {
  const number = carNumber.trim().replace(/^#/, '');
  if (!number) return null;
  const published = cal.rounds.filter((r) => r.entries > 0).sort((a, b) => b.order - a.order);
  for (const r of published) {
    const rows = await seriesApi.entries(series, year, r.round_id);
    const ours = rows.find((e) => e.car_number.trim() === number);
    if (ours) return ours;
  }
  return null;
}
