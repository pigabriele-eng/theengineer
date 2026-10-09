// What a run row on the home page says about the run's driver (components/RunDriverLine.tsx): the driver set on it,
// else who the driving style says drove it (server: routers/driver_style.py), else nobody. A style no driver is named
// for yet ("Style A") is never shown: the run simply has no driver.
import type { RunGuess } from './fingerprints';
import type { GarageDriver } from './garage';

export type DriverRun = { id: number; name: string; driver_id?: number | null; driver?: string | null };

export type DriverState =
  | { kind: 'set'; name: string } // named by a person
  | { kind: 'auto'; name: string; how: string } // set by the app: how ("by style", "by qualifying order")
  | { kind: 'guess'; name: string; sure: boolean; confirm: number | null } // not set: what the style says
  | { kind: 'none' };

/** The run's driver (set by a person, or from the style), else the style's guess when it names a driver (with the
 * driver to confirm, or none for a driver change at a stop), else nothing. The run's own driver wins over a guess
 * read before it was changed. */
export function driverState(run: DriverRun, guess: RunGuess | undefined,
  garage: { drivers: Pick<GarageDriver, 'id' | 'name'>[] } | null): DriverState {
  const nameOf = (id: number | null | undefined) =>
    id == null ? null : garage?.drivers.find((d) => d.id === id)?.name ?? null;
  if (run.driver_id != null) {
    const name = nameOf(run.driver_id) ?? run.driver ?? 'Driver set';
    return guess?.auto && guess.driver_id === run.driver_id ? { kind: 'auto', name, how: autoHow(guess.auto.source) }
      : { kind: 'set', name };
  }
  if (!guess) return { kind: 'none' };
  if (guess.stints.length > 1) {
    // a driver change at a stop: said only when the style names every driver
    const names = guess.stints.map((st) => (st.driver_id == null ? null : nameOf(st.driver_id) ?? st.label));
    if (names.some((n) => n == null)) return { kind: 'none' };
    const order = names.filter((n, i) => i === 0 || n !== names[i - 1]);
    return order.length > 1 ? { kind: 'guess', name: order.join(', then '), sure: true, confirm: null } : { kind: 'none' };
  }
  const s = guess.suggestion;
  const name = nameOf(s.driver_id) ?? s.driver;
  if (s.driver_id == null || !name) return { kind: 'none' };
  return { kind: 'guess', name, sure: s.confidence === 'sure', confirm: s.driver_id };
}

/** How the app set a run's driver, in a few words: from the qualifying order (Q1 PIA, Q2 SYL: server
 * quali_order.py), the season's drivers, or the driving style. */
export function autoHow(source: string): string {
  if (source === 'quali' || source === 'race') return 'by qualifying order';
  return source === 'season' ? "by season's drivers" : 'by style';
}

/** The line's words: the driver, "Probably <name>" for a guess the style isn't sure of, or "No driver". */
export function driverWords(st: DriverState) {
  if (st.kind === 'none') return 'No driver';
  return st.kind === 'guess' && !st.sure ? `Probably ${st.name}` : st.name;
}
