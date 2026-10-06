// The garage's tyres and vehicles in the engineering tools: the pressure calculator and the tyre model work per tyre,
// the vehicle model and the setup tool per vehicle (server/app/tyres/kinds.py, server/app/vehicle/specs.py).
import { apiFetch } from '@/lib/api';
import { Reference } from '@/lib/tyres';
import { Preset, Vehicle } from '@/lib/vehicle';

export type AxlePair = { front: number | null; rear: number | null };

/** A tyre's P-Book pressures. origin: its own specs ('tyre'), the per-series minimums entered for it by name
 * ('series'), or none yet. */
export type PBook = {
  cold_min_bar: AxlePair;
  hot_min_bar: AxlePair;
  hot_target_bar: AxlePair;
  source: string | null;
  origin: 'tyre' | 'series' | null;
  series?: string[];
};

export type TyreKind = {
  id: number;
  brand: string;
  compound: string;
  label: string;
  size: string | null;
  specs: Record<string, unknown>;
  notes: string | null;
  sessions: number;
  pbook: PBook;
};

/** Sessions whose event names no tyre, by event (event_id null: sessions in no event). */
export type NotSet = { sessions: number; events: { event_id: number | null; name: string | null; sessions: number }[] };

export type VehicleItem = {
  id: number;
  name: string;
  maker: string | null;
  car_class: string | null;
  stored: number; // how many of the vehicle model's inputs its specs hold
  missing: string[];
  base: { key: string; name: string } | null;
  template: string;
};

/** A vehicle as the vehicle model's inputs: like a preset, with the inputs its specs hold and those it still needs
 * (null in vehicle). */
export type VehicleDetail = Omit<Preset, 'vehicle'> & {
  id: number;
  vehicle: Record<keyof Vehicle, Vehicle[keyof Vehicle] | null>;
  stored: string[];
  missing: string[];
  problem: string | null;
  base: { key: string; name: string } | null;
  template: string;
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

const put = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const toolLists = {
  tyres: () => request<{ tyres: TyreKind[]; not_set: NotSet; reference: Reference }>('/tyres/kinds'),
  /** Store a tyre's P-Book pressures in its specs (the rest of its specs is kept). */
  saveTyreBook: (t: TyreKind, book: Pick<PBook, 'cold_min_bar' | 'hot_min_bar' | 'hot_target_bar' | 'source'>) =>
    request<unknown>(`/catalog/tyres/${t.id}`, put({ specs: { ...t.specs, ...book } })),
  vehicles: (sessionId?: number) =>
    request<{ vehicles: VehicleItem[]; session_vehicle_id: number | null }>(
      `/vehicle/vehicles${sessionId != null ? `?session_id=${sessionId}` : ''}`,
    ),
  vehicle: (id: number) => request<VehicleDetail>(`/vehicle/vehicles/${id}`),
  /** Store the vehicle model's inputs as the vehicle's specs (anything else in them is kept). */
  saveVehicle: (id: number, v: Vehicle) => request<VehicleDetail>(`/vehicle/vehicles/${id}/specs`, put(v)),
};

/** "2 sessions in 02_ADACGT4_T01_HOC" lines for the events whose tyre isn't set. */
export const eventLabel = (e: NotSet['events'][number]) =>
  `${e.name ?? 'No event'} · ${e.sessions} session${e.sessions === 1 ? '' : 's'}`;
