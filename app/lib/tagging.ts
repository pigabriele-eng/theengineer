// The Tag drivers screen's outings: one block per event, the same events, names and dates as the Sessions tab (the
// folders of lib/events.ts), newest first, each with its outings in run order by day; the outings in no event last.
import { whenOf } from '@/lib/calendar';
import { eventsApi, Folder, FolderSession } from '@/lib/events';

// An outing as the server sends it, with its driver's id
export type Outing = FolderSession & { driver_id?: number | null };

/** Every event that has outings, each with its days, newest first; the folder of outings in no event last. */
export async function loadBlocks(): Promise<Folder[]> {
  const folders = (await eventsApi.folders()).filter((f) => f.sessions > 0); // planned events have none to tag
  const ordered = [...folders.filter((f) => f.id != null), ...folders.filter((f) => f.id == null)];
  return inTurns(ordered, 4, (f) => eventsApi.folder(f.key));
}

// A few requests at a time, so a season of events doesn't take every database connection of the server at once.
async function inTurns<T, R>(items: T[], lanes: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, lane));
  return out;
}

export const outingsOf = (b: Folder) => b.days.flatMap((d) => d.sessions) as Outing[];

export const withoutDriver = (outings: Outing[]) => outings.filter((o) => o.driver_id == null).length;

/** The block that opens by itself: the event on now (from the day before to its last day), else the newest. */
export function firstOpen(blocks: Folder[], today: string): string | null {
  const events = blocks.filter((b) => b.id != null);
  return (events.find((b) => whenOf(b, today) === 'current') ?? events[0] ?? blocks[0])?.key ?? null;
}
