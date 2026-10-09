// Driver fingerprints (server: routers/driver_style.py): who drove each run of an event by driving style alone, and
// the database of every driver's style.
import { apiFetch } from '@/lib/api';

export type Trait = { kind: string; label: string; explain: string; value: number; words: string };

export type StyleGroup = {
  index: number;
  label: string; // the driver's name, else "New driver" (asked about: never a letter)
  driver_id: number | null;
  driver: string | null;
  // named after a tagged run here, a fingerprint from other events, the car's other driver, or not yet
  source: 'tag' | 'fingerprint' | 'entry' | '';
  match: number | null;
  laps: number;
  best_s?: number;
  typical_s?: number;
  traits: Trait[];
};

export type Suggestion = {
  group: number;
  label: string;
  driver_id: number | null;
  driver: string | null;
  confidence: 'sure' | 'likely';
  share: number; // of the run's laps in that style
  laps: number;
};

export type RunStint = { first_lap: number; last_lap: number; laps: number; group: number; label: string;
  driver_id: number | null };

export type RunGuess = {
  session_id: number;
  driver_id: number | null; // as tagged now
  suggestion: Suggestion;
  agrees: boolean | null; // the tag against the style, when both are known
  stints: RunStint[]; // two or more when the driver changed at a stop
  auto: { source: string; match: number | null } | null; // its driver was set from the driving style, not by a person
};

export type EventGuess = {
  status: 'ready' | 'working';
  mode: 'tagged' | 'alike' | 'groups' | 'one style' | 'too few laps'; // alike: tagged drivers too alike to tell apart
  separation: number | null;
  groups: StyleGroup[];
  sessions: RunGuess[];
};

export type Advice = { kind: string; type: 'gain' | 'strength'; label: string; r: number; words: string };

export type DriverPrint = {
  driver_id: number;
  driver: string;
  laps: number;
  events: { event_id: number; event: string | null; date: string | null; laps: number; best_s?: number;
    typical_s?: number; teammates: string[]; gap_to_teammates_s: number | null; session_ids?: number[] }[];
  traits: Trait[];
  advice: Advice[];
  also_found: { event_id: number; event: string | null; laps: number; match: number; session_ids?: number[] }[];
};

export type LapLink = { kind: string; label: string; r: number; laps: number; outcome: boolean; words: string };

export type FingerprintDb = {
  updating: boolean;
  events: number;
  drivers: DriverPrint[];
  links: LapLink[];
  // a style the app can't name yet: label is its runs' names
  unnamed: { event_id: number; event: string | null; label: string; laps: number; session_ids?: number[] }[];
  kinds: { kind: string; label: string; explain: string }[];
};

async function get<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const fingerprintsApi = {
  event: (eventId: number) => get<EventGuess>(`/events/${eventId}/driver-guess`),
  all: () => get<FingerprintDb>('/drivers/fingerprints'),
};

/** The run's line under its driver: what the style says, or null when there is nothing worth saying. */
export function guessLine(g: RunGuess | undefined, mode: EventGuess['mode'] | undefined): string | null {
  if (g?.auto?.source === 'season' && g.driver_id != null) return "Driver set from the season's drivers";
  if (g?.auto?.source === 'quali' && g.driver_id != null) return 'Driver set from the qualifying order';
  if (g?.auto?.source === 'race' && g.driver_id != null) {
    return 'Driver set from the qualifying order: the Q1 driver starts Race 1, the Q2 driver Race 2';
  }
  if (!g || !mode || mode === 'too few laps') return null;
  if (mode === 'alike') return g.driver_id == null ? "The drivers drive too alike to tell apart here: pick who drove" : null;
  const s = g.suggestion;
  if (g.auto && g.driver_id != null) return 'Driver set from the driving style';
  if (g.stints.length > 1) {
    const parts = g.stints.map((st) => `${st.label} laps ${st.first_lap}–${st.last_lap}`);
    return `Driver change at a stop: ${parts.join(', then ')}`;
  }
  if (mode === 'one style' && !s.driver) return null; // one driver throughout, nobody named yet: nothing to add
  if (g.driver_id != null) {
    return g.agrees === false ? `The driving style looks like ${s.label}` : null;
  }
  if (s.driver) return `${s.confidence === 'sure' ? 'Drives like' : 'Probably'} ${s.driver}`;
  return mode === 'groups' ? 'A driver the app doesn\'t know yet: name them once, above or here' : null;
}
