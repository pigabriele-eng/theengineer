// A run's tyres, four levels (server/app/run_tyres.py): the driver's pick, else guessed from the event's laps.
export type TyreLevel = 'new' | 'fresh' | 'used' | 'worn';
export const TYRE_LEVELS: TyreLevel[] = ['new', 'fresh', 'used', 'worn'];
export const TYRE_LABEL: Record<TyreLevel, string> = { new: 'New', fresh: 'Fresh', used: 'Used', worn: 'Very used' };
/** Laps already on the set when a run starts: from these on, Used, then Very used (run_tyres.FRESH_UNDER, USED_UNDER). */
export const TYRE_STEPS = { fresh: 10, used: 25 };
/** A run's tyres as every page has them: the level, whether the driver set it, and why it was guessed. */
export type RunTyres = {
  tyres: TyreLevel;
  label?: string;
  pair?: 'new' | 'used'; // new or not: what the technique check keeps apart
  sure: boolean;
  why: string;
  set_laps?: number | null; // laps on the set when the run started, when known
  check?: boolean; // a guess against the series' usual new sets (GT4 European): worth checking
  laps?: number | null; // the event's clean laps compared with this run's (technique check)
};
