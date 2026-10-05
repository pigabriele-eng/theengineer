// Client for the vehicle tools on the server: the vehicle model, setup what-ifs, car presets and the tyre fit.
import { apiFetch } from '@/lib/api';

// One car and its setup. Lengths in mm, rates in N/mm, masses in kg. Motion ratio = spring (or bar link)
// travel / wheel travel. Bar rate = force at one drop link per mm, other end held.
export type Vehicle = {
  mass_kg: number;
  front_weight_fraction: number;
  cog_height_mm: number;
  wheelbase_mm: number;
  track_front_mm: number;
  track_rear_mm: number;
  roll_centre_front_mm: number;
  roll_centre_rear_mm: number;
  spring_front_n_per_mm: number;
  spring_rear_n_per_mm: number;
  spring_mr_front: number;
  spring_mr_rear: number;
  arb_front_n_per_mm: number;
  arb_rear_n_per_mm: number;
  arb_mr_front: number;
  arb_mr_rear: number;
  arb_front_settings_n_per_mm: number[] | null;
  arb_rear_settings_n_per_mm: number[] | null;
  arb_front_setting: number | null;
  arb_rear_setting: number | null;
  tyre_vertical_front_n_per_mm: number;
  tyre_vertical_rear_n_per_mm: number;
  tyre_radius_mm: number;
  unsprung_front_kg: number;
  unsprung_rear_kg: number;
  downforce_n: number;
  aero_balance_front: number;
  aero_ref_speed_kmh: number;
  braking_g: number;
  acceleration_g: number;
};

export type Provenance = {
  value: unknown;
  confidence: 'published' | 'estimate' | 'unknown';
  source: string | null;
  note: string;
};

export type Preset = {
  key: string;
  name: string;
  vehicle: Vehicle;
  values: Partial<Record<keyof Vehicle, Provenance>>;
  steering_ratio: Provenance;
  published: string[];
};

type LoadTransfer = { geometric: number; elastic: number; unsprung: number; total: number };

export type AxleResult = {
  sprung_mass_kg: number;
  wheel_rate_n_per_mm: number;
  bar_wheel_rate_n_per_mm: number;
  ride_rate_n_per_mm: number;
  ride_frequency_hz: number;
  roll_stiffness_springs_nm_per_deg: number;
  roll_stiffness_bar_nm_per_deg: number;
  roll_stiffness_nm_per_deg: number;
  lateral_load_transfer_n_per_g: LoadTransfer;
};

export type Balance = {
  front_weight_share: number;
  lateral_load_transfer_front_share: number;
  difference: number;
  reading: string;
  front_load_share_at_speed: number | null;
  difference_at_speed: number | null;
  reading_at_speed: string | null;
};

export type ModelResult = {
  axles: { front: AxleResult; rear: AxleResult };
  ride_frequency_ratio: number;
  roll_stiffness_front_share: number;
  roll_gradient_deg_per_g: number;
  sprung_cog_height_mm: number;
  roll_axis_height_mm: number;
  roll_arm_mm: number;
  lateral_load_transfer_front_share: number;
  longitudinal: {
    per_g_n: number;
    braking_g: number;
    braking_front_gain_n: number;
    acceleration_g: number;
    acceleration_rear_gain_n: number;
  };
  balance: Balance;
};

export type Change = { field: keyof Vehicle; set?: number; add?: number; percent?: number };

export type Delta = { key: string; label: string; unit: string; baseline: number; changed: number; delta: number };

export type WhatIfResult = { baseline: ModelResult; changed: ModelResult; deltas: Delta[]; summary: string };

export type AxleFit = {
  peak_mu: number;
  slip_at_peak_deg: number;
  shape: number;
  shape_fitted: boolean;
  slip_offset_deg: number;
  peak_reached: boolean;
  cornering_stiffness_mu_per_deg: number;
  peak_mu_range?: [number, number];
  slip_at_peak_range_deg?: [number, number];
  samples: number;
  load_bins: number;
  rmse_mu: number;
  r2: number | null;
  slip_scatter_deg: number;
  slip_range_deg: [number, number];
  mu_observed_max: number;
  slip_at_mu_max_deg: number;
  note: string | null;
};

export type TyreFit = {
  samples: number;
  corners: number;
  sessions: {
    samples: number;
    corners: number;
    corners_dropped: number;
    yaw_rate_scale: number;
    steering: { ratio: number; source: 'entered' | 'logger' | 'data'; note?: string };
  }[];
  skipped: { session_id: number; reason: string }[];
  speed_range_kmh: [number, number];
  axles: { front: AxleFit; rear: AxleFit };
  curves: { alpha_deg: number[]; front: number[]; rear: number[] };
  binned: Record<'front' | 'rear', { alpha_deg: number[]; mu: number[]; count: number[] }>;
  assumptions: string[];
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body.detail;
    // FastAPI validation errors come as a list of {loc, msg}
    const message = Array.isArray(detail)
      ? detail.map((d: { loc?: string[]; msg: string }) => `${d.loc?.slice(-1)[0] ?? ''}: ${d.msg}`).join('; ')
      : detail;
    throw new Error(message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const DEFAULT_PRESET = 'bmw-m4-gt4-evo';

export const vehicleApi = {
  presets: () => request<{ key: string; name: string }[]>('/vehicle/presets'),
  preset: (key: string) => request<Preset>(`/vehicle/presets/${key}`),
  model: (v: Vehicle) => request<ModelResult>('/vehicle/model', post(v)),
  whatIf: (baseline: Vehicle, changes: Change[]) =>
    request<WhatIfResult>('/vehicle/what-if', post({ baseline, changes })),
  tyreFit: (body: { session_ids: number[]; vehicle?: Vehicle; steering_ratio?: number | null; preset?: string }) =>
    request<TyreFit>('/vehicle/tyre-fit', post(body)),
};

export const pct = (x: number | null | undefined, digits = 1) => (x == null ? '–' : `${(x * 100).toFixed(digits)} %`);
