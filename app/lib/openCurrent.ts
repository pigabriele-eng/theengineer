// Opening the app while an event is on lands on that event's page instead of the event list; Back and the Sessions
// tab still reach the list. Once per launch (a fresh load of the web app, a launch of the phone app), and only when
// the app was opened on the list itself, so a link to another page (a report, say) still opens that page.
import { usePathname } from 'expo-router';

import { whenOf } from '@/lib/calendar';
import { FolderSummary } from '@/lib/events';

// 'list': opened on the event list and the event that's on not looked for yet; 'done': opened on another page, or
// already looked for. Module state lives as long as the app does.
let launch: 'list' | 'done' | null = null;

/** Notes where the app was opened, on its first render; rendered by the root layout. A component of its own so that
 * only it, not the whole app, re-renders on every move. Sign-in counts as the list: it goes there next. */
export function NoteLaunch() {
  const pathname = usePathname();
  if (launch === null) launch = pathname === '/' || pathname === '/sign-in' ? 'list' : 'done';
  return null;
}

/** The event to open, asked once the list has its events: the one that's on, the first time only, and only when the
 * app was opened on the list. */
export function launchEvent(folders: FolderSummary[], today: string): FolderSummary | null {
  const first = launch === 'list';
  launch = 'done';
  return first ? currentEvent(folders, today) : null;
}

/** Of the current events (the day before to the last day; planned ones without data too), the one whose days contain
 * today, else the one starting soonest. Two on today: the one that started last; still a tie: the newest. */
export function currentEvent(folders: FolderSummary[], today: string): FolderSummary | null {
  const on = folders.filter((f) => f.id != null && whenOf(f, today) === 'current');
  const start = (f: FolderSummary) => f.start ?? f.end ?? '';
  const onToday = (f: FolderSummary) => start(f) <= today; // current: the last day isn't past yet
  on.sort((a, b) => {
    if (onToday(a) !== onToday(b)) return onToday(a) ? -1 : 1;
    if (start(a) !== start(b)) return (start(a) > start(b)) === onToday(a) ? -1 : 1;
    return (b.id ?? 0) - (a.id ?? 0);
  });
  return on[0] ?? null;
}
