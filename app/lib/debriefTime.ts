// When a debrief was recorded, as the server matches it to the run that ended just before: local time on this
// device with no zone, as the logger writes its own date and time.

const two = (n: number) => String(n).padStart(2, '0');

/** "2026-10-09T14:32:05" for a Date, on this device's clock. */
export function localTime(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** When a picked audio file was recorded: its last change (the end of a voice memo), else now. */
export function fileRecordedAt(lastModified: number | undefined, now: Date = new Date()): string {
  return localTime(lastModified ? new Date(lastModified) : now);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 9 Oct, 14:32" from the server's local time (read as written, never moved to another zone). */
export function recordedLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m.map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${DAYS[day]} ${d} ${MONTHS[mo - 1]}, ${two(h)}:${two(mi)}`;
}

/** The line under a debrief that joined its run by time: "Recorded 6 min after FP2 ended, so it went with that run." */
export function linkedLine(run: string, minutes: number | undefined): string {
  if (minutes == null) return `Recorded after ${run}, so it went with that run.`;
  if (minutes < 1) return `Recorded as ${run} ended, so it went with that run.`;
  return `Recorded ${minutes} min after ${run} ended, so it went with that run.`;
}
