// The garage (server/app/routers/garage.py): teams, cars (number, model, team, the loggers in them) and drivers (team,
// the cars they drive), and a run's driver and car set in one call.
import { apiFetch } from '@/lib/api';

export type GarageTeam = { id: number; name: string; car_ids: number[]; driver_ids: number[] };

export type GarageCar = {
  id: number;
  name: string; // "BMW M4 GT4 Evo (G82) #21"
  number: string | null;
  model: string | null;
  team_id: number | null;
  team: string | null;
  loggers: number[]; // serial numbers of the loggers fitted to it
  driver_ids: number[];
  runs: number;
};

export type GarageDriver = {
  id: number;
  name: string;
  team_id: number | null;
  team: string | null;
  car_ids: number[];
  runs: number;
};

// A logger seen in the logs: its serial number, how many runs it logged, where and when it last did, its car.
export type Logger = { serial: number; runs: number; last: string | null; venue: string | null; car_id: number | null };

export type Garage = {
  teams: GarageTeam[];
  cars: GarageCar[];
  drivers: GarageDriver[];
  loggers: Logger[];
  models: string[]; // models to offer when a car is added
};

// Only the fields sent change. A team by id, or by name (an existing team of that name, else a new one).
export type CarFields = {
  number?: string | null;
  model?: string | null;
  team_id?: number | null;
  team_name?: string;
  loggers?: number[];
  driver_ids?: number[];
};

export type DriverFields = { name?: string; team_id?: number | null; team_name?: string; car_ids?: number[] };

// A run's driver (by id, or a new one by name; null clears) and car (null clears); only the fields sent change.
export type RunFields = { driver_id?: number | null; driver_name?: string; car_id?: number | null };

export type RunSet = {
  id: number;
  driver_id: number | null;
  driver: string | null;
  car_id: number | null;
  car: string | null;
  filled: number[]; // other runs that got the car too: the run's logger is now fitted to it
  logger: number | null; // that logger's serial number
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail) ? body.detail.map((d: { msg: string }) => d.msg).join('; ') : body.detail;
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : res.json()) as Promise<T>;
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const garageApi = {
  get: () => call<Garage>('/garage'),
  addTeam: (name: string) => call<{ id: number; name: string }>('/garage/teams', send('POST', { name })),
  renameTeam: (id: number, name: string) => call<{ id: number; name: string }>(`/garage/teams/${id}`, send('PATCH', { name })),
  removeTeam: (id: number) => call<void>(`/garage/teams/${id}`, { method: 'DELETE' }),
  addCar: (body: CarFields) => call<{ car: GarageCar; filled: number[] }>('/garage/cars', send('POST', body)),
  updateCar: (id: number, body: CarFields) =>
    call<{ car: GarageCar; filled: number[] }>(`/garage/cars/${id}`, send('PATCH', body)),
  removeCar: (id: number) => call<void>(`/garage/cars/${id}`, { method: 'DELETE' }),
  addDriver: (body: DriverFields) => call<GarageDriver>('/garage/drivers', send('POST', body)),
  updateDriver: (id: number, body: DriverFields) => call<GarageDriver>(`/garage/drivers/${id}`, send('PATCH', body)),
  removeDriver: (id: number) => call<void>(`/garage/drivers/${id}`, { method: 'DELETE' }),
  setRun: (sessionId: number, body: RunFields) => call<RunSet>(`/garage/runs/${sessionId}`, send('PATCH', body)),
};

/** "#21" when the car has a number, else its name: short enough for a chip. */
export const carShort = (c: GarageCar) => (c.number ? `#${c.number}` : c.name);

/** "#21 · BMW M4 GT4 Evo (G82)", for lists. */
export const carLong = (c: GarageCar) =>
  c.number && c.model ? `#${c.number} · ${c.model}` : c.number ? `#${c.number}` : c.name;

/** The drivers to offer for a run: the drivers of its car first, then everyone else. */
export function driversFor(garage: Garage, carId: number | null | undefined) {
  const car = garage.cars.find((c) => c.id === carId);
  const first = car ? garage.drivers.filter((d) => car.driver_ids.includes(d.id)) : [];
  return { first, rest: garage.drivers.filter((d) => !first.includes(d)) };
}

/** The cars to offer for a run: the cars of the run's driver first (they're the likely ones), then the rest. */
export function carsFor(garage: Garage, driverId: number | null | undefined) {
  const driver = garage.drivers.find((d) => d.id === driverId);
  const first = driver ? garage.cars.filter((c) => driver.car_ids.includes(c.id)) : [];
  return { first, rest: garage.cars.filter((c) => !first.includes(c)) };
}
