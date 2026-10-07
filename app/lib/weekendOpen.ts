// Which events are race weekends (not coaching days), and the next weekend the app opens on when none is on. Pure, so
// it can be tested with `npm test`.
import type { FolderSummary } from './events';

/** How far ahead the app looks for the next weekend to open on. */
export const NEXT_WEEKEND_DAYS = 14;

/** A coaching day (the event's mode, from GET /events/folders); everything else is a race weekend. */
export const isCoachingDay = (f: FolderSummary) => (f as FolderSummary & { mode?: string }).mode === 'coaching';

/** The race weekends among events: coaching days left out. */
export const weekendsOf = (folders: FolderSummary[]) => folders.filter((f) => !isCoachingDay(f));

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** The next weekend not on yet (its first day after tomorrow) that starts within `days` days, the soonest first;
 * the same start: the newest. Coaching days and events without a date are not looked at. */
export function nextWeekend(folders: FolderSummary[], today: string, days = NEXT_WEEKEND_DAYS): FolderSummary | null {
  const from = addDays(today, 1); // from the day before an event it counts as on
  const until = addDays(today, days);
  const ahead = weekendsOf(folders).filter((f) => {
    const start = f.start ?? f.end;
    return f.id != null && start != null && start > from && start <= until;
  });
  ahead.sort((a, b) => ((a.start ?? a.end)! < (b.start ?? b.end)! ? -1 : (a.start ?? a.end)! > (b.start ?? b.end)! ? 1
    : (b.id ?? 0) - (a.id ?? 0)));
  return ahead[0] ?? null;
}
