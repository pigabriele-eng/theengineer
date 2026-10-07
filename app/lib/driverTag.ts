// The driver on a run's name line, plainly (Gabriele, 2026-10-07: "in the runs overview the driver is not visible so
// it's difficult to pick runs to compare"): a short code from the surname (PIA for Piana, RAC for Rackl), "PIA?" when
// only the driving style says so, "Driver?" when nobody knows. Pure, so `npm test` checks it.
import type { DriverState } from './runDriver';

export type DriverTag = { text: string; kind: 'known' | 'guess' | 'none'; name: string | null };

/** A driver's short code: the first three letters of the last name in capitals ("Max Piana" PIA, "Kelvin van der
 * Linde" LIN); a name shorter than that as it is. */
export function driverCode(name: string) {
  const s = (name.trim().split(/\s+/).at(-1) ?? '').replace(/[^\p{L}\p{N}]/gu, '');
  return s.length >= 3 ? s.slice(0, 3).toUpperCase() : name.trim();
}

/** The tag for a run's driver state (lib/runDriver.ts driverState): known (set by a person or from the style), a
 * guess, or none. A driver change at a stop reads "PIA/RAC?". */
export function driverTag(st: DriverState): DriverTag {
  if (st.kind === 'none') return { text: 'Driver?', kind: 'none', name: null };
  const code = st.name.split(', then ').map(driverCode).join('/');
  return st.kind === 'guess' ? { text: `${code}?`, kind: 'guess', name: st.name } : { text: code, kind: 'known', name: st.name };
}

/** The tag for a run known only by its driver's name (the compare page's list): the code, or nothing. */
export const codeOf = (name: string | null | undefined) => (name ? driverCode(name) : null);
