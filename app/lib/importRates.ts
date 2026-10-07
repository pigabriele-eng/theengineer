// How fast the server imports (GET /imports/rates, server/app/import_rates.py), for the time left of an upload while
// its files are still going out; the import job carries its own time left once it exists (`eta`).
import { apiFetch, ImportJob } from '@/lib/api';
import { Eta, FALLBACK_RATES, Rates } from '@/lib/uploadEta';

/** The import job as GET /imports/{id} answers it, with the seconds left while it runs. */
export type JobWithEta = ImportJob & { eta?: Eta | null };

/** The rates, or the server's own guesses when they can't be had (the upload goes on all the same). */
export async function importRates(): Promise<Rates> {
  try {
    const res = await apiFetch('/imports/rates');
    return res.ok ? { ...FALLBACK_RATES, ...(await res.json()) } : FALLBACK_RATES;
  } catch {
    return FALLBACK_RATES;
  }
}
