// Client for the accumulating tyre model: every log of a car summarised once in the background, and one model
// fitted from all of them (server/app/routers/tyre_model.py).
import { apiFetch } from '@/lib/api';
import { AxleFit } from '@/lib/vehicle';

export type Axle = 'front' | 'rear';
export const AXLES: Axle[] = ['front', 'rear'];

/** How far the background summaries have got, in logs. */
export type SummaryStatus = {
  summarised: number;
  without_cornering: number;
  failed: number;
  pending: number;
  running: boolean;
};

export type ModelCar = {
  key: string;
  label: string;
  sessions: number;
  tyres: { name: string; sessions: number }[];
  tracks: { name: string; sessions: number }[];
  dates: string[];
};

/** Laps grouped by a condition: their grip at the same slip angle against the average lap (0.03 = 3 % more). */
export type ConditionGroup = {
  from: number;
  to: number;
  laps: number;
  sessions: number;
  samples: number;
  grip: number | null; // null: too few laps or samples at high grip
  low: number | null; // the middle 90 % when sessions and laps are redrawn; null from fewer than 3 sessions
  high: number | null;
};

export type GripWindow = {
  from: number;
  to: number;
  open: 'low' | 'high' | null; // the window runs to the edge of what was seen: the best may lie beyond it
  grip: number;
  gain?: number;
  confidence: 'high' | 'medium' | 'low' | 'none'; // low: only a few runs show it
  held?: number; // refits with one session left out that still show it ...
  of?: number; // ... of this many
  sessions: number;
  laps: number;
  text: string;
};

export type ConditionKey = 'temperature' | 'pressure' | 'tyre_laps';

export type Condition = {
  label: string;
  unit: string;
  note: string;
} & Record<Axle, { bins: ConditionGroup[]; window: GripWindow | null }>;

export type ModelSession = {
  session_id: number;
  name: string;
  track: string | null;
  date: string | null;
  tyre: string | null;
  ambient_c: number | null;
  laps: number;
  samples: number;
  slip_shift_deg: Record<Axle, number>;
  yaw_rate_scale: number;
  steering: { ratio: number; source: 'entered' | 'logger' | 'data' };
};

export type TyreModel = {
  car: { key: string; label: string };
  tyre: string;
  filters: { track: string | null; ambient_min: number | null; ambient_max: number | null };
  choices: { tyres: { name: string; sessions: number }[]; tracks: string[] };
  status: SummaryStatus;
  basis: {
    sessions: number;
    laps: number;
    samples: number;
    corners: number;
    tracks: string[];
    dates: string[];
    ambient_c: [number, number] | null;
    speed_range_kmh: [number, number];
    with_tpms: number;
    with_tyre_laps: number;
  };
  advice: string[];
  axles: Record<Axle, AxleFit & { advice: string }>;
  curves: { alpha_deg: number[]; front: number[]; rear: number[] };
  binned: Record<Axle, { alpha_deg: number[]; mu: number[]; count: number[] }>;
  conditions: Record<ConditionKey, Condition>;
  sessions: ModelSession[];
  assumptions: string[];
};

export type ModelQuery = {
  car: string;
  tyre?: string | null;
  track?: string | null;
  ambient_min?: number | null;
  ambient_max?: number | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body.detail;
    const message = Array.isArray(detail)
      ? detail.map((d: { loc?: string[]; msg: string }) => `${d.loc?.slice(-1)[0] ?? ''}: ${d.msg}`).join('; ')
      : detail;
    throw new Error(message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const tyreModelApi = {
  cars: () => request<{ cars: ModelCar[]; status: SummaryStatus }>('/tyre-model/cars'),
  status: () => request<SummaryStatus>('/tyre-model/status'),
  model: async (q: ModelQuery) => {
    const params = new URLSearchParams({ car: q.car });
    if (q.tyre) params.set('tyre', q.tyre);
    if (q.track) params.set('track', q.track);
    if (q.ambient_min != null) params.set('ambient_min', String(q.ambient_min));
    if (q.ambient_max != null) params.set('ambient_max', String(q.ambient_max));
    // nothing to fit (filters match no session, too little cornering) comes back as "empty": the reason
    const r = await request<TyreModel | { empty: string }>(`/tyre-model?${params}`);
    if ('empty' in r && r.empty) throw new Error(r.empty);
    return r as TyreModel;
  },
  /** Name the tyre a session ran (empty: the car's usual), so the model keeps tyres apart. */
  setTyre: (sessionId: number, tyre: string) =>
    request<{ session_id: number; tyre: string; logs: number }>(`/tyre-model/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tyre }),
    }),
};

/** Grip against the average as a signed number of percent: +5.1, −2.9, 0 (no sign once rounded to zero). */
export const gripNum = (x: number, digits = 1) => {
  const v = Number((x * 100).toFixed(digits));
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
};

/** Grip against the average as a signed percentage: +5.1 %, −2.9 %. */
export const gripPct = (x: number, digits = 1) => `${gripNum(x, digits)} %`;
