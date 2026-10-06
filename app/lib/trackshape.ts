// Client for the track's shape (GET /sessions/{id}/shape and /events/{id}/shape): height along the lap, road bank
// and vertical load, and the banked corners, crests and compressions found, on the line the track map is drawn from.
import { apiFetch } from '@/lib/api';

export type ShapeKind = 'banked' | 'crest' | 'compression';

export type ShapeFeature = {
  kind: ShapeKind;
  start_m: number;
  end_m: number; // below start_m for a stretch through the start/finish line
  value: number; // banked: degrees; crest and compression: vertical load in g
  corner: string | null; // the corner it falls in, as the map numbers its sections
};

export type TrackShapeData = {
  session_id: number;
  reference_lap: number;
  length_m: number;
  numbering: 'official' | 'detected';
  laps: number; // quick laps it was learned from
  sessions: number;
  step_m: number; // point j is metre j * step_m of the lap
  elevation_m: (number | null)[]; // height above the lap's lowest point
  bank_deg: (number | null)[]; // + toward the inside of the corner; null where it can't be told
  load_g: (number | null)[]; // 1 on a flat road, below 1 over a crest, above 1 in a compression or banking
  features: ShapeFeature[];
  corners: { code: string; apex_m: number; start_m: number; end_m: number }[]; // the map's sections
  banked_note: string | null; // one plain line naming the banked corners
};

/** The shape, or null when the logs can't tell it (no clean lap, too few laps): not a failure. */
export async function fetchTrackShape(target: { session?: number; event?: number }): Promise<TrackShapeData | null> {
  const path = target.event != null ? `/events/${target.event}/shape` : `/sessions/${target.session}/shape`;
  const res = await apiFetch(path);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<TrackShapeData>;
}

export const KIND_LABEL: Record<ShapeKind, string> = {
  banked: 'Banked',
  crest: 'Crest',
  compression: 'Compression',
};

/** A feature's stretch in metres from the line; through the line, its end is past the lap's length. */
export const featureSpan = (f: ShapeFeature, length: number) =>
  ({ start: f.start_m, end: f.end_m < f.start_m ? f.end_m + length : f.end_m });

/** The middle of a feature's stretch, in metres from the line. */
export const featureMid = (f: ShapeFeature, length: number) => {
  const { start, end } = featureSpan(f, length);
  return ((start + end) / 2) % length;
};

/** Whether metre m of the lap is in the feature's stretch. */
export const inFeature = (f: ShapeFeature, m: number) =>
  f.start_m <= f.end_m ? m >= f.start_m && m <= f.end_m : m >= f.start_m || m <= f.end_m;

/** "about 15°" for a bank, "0.62 g" for a crest or compression. */
export const featureValue = (f: ShapeFeature) =>
  f.kind === 'banked' ? `about ${Math.round(Math.abs(f.value))}°` : `${f.value.toFixed(2)} g`;
