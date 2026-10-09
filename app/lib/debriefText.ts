// The debrief report as plain text, to send by WhatsApp, Mail or Messages (the Share link on app/debrief/[id].tsx).
// Pure, so `npm test` can run it (lib/debriefText.test.mjs): the page passes in the sections and what it knows.
import type { Debrief } from './api';

export type DebriefHeader = {
  event?: string | null; // the event's name
  run?: string | null; // the session or run name
  date?: string | null; // already written out ("12 Oct 2026")
  driver?: string | null;
};

const PHASE: Record<string, string> = { braking: 'braking', entry: 'entry', mid: 'mid-corner', exit: 'exit' };

export function debriefText(
  d: Pick<Debrief, 'mode' | 'summary' | 'speakers' | 'points'>,
  sections: [string, string][],
  head: DebriefHeader = {},
): string {
  const lines: string[] = ['DEBRIEF REPORT'];
  const title = [head.event, head.run].map((s) => s?.trim()).filter(Boolean).join(' · ');
  if (title) lines.push(title);
  const meta = [head.date, head.driver ? `Driver: ${head.driver}` : null].filter(Boolean).join(' · ');
  if (meta) lines.push(meta);
  if (d.summary?.trim()) lines.push('', d.summary.trim());

  // who said it, in a group debrief only
  const who = (key: string | null) => {
    if (d.mode !== 'group' || !key) return null;
    const sp = d.speakers?.[key];
    return sp ? sp.name ?? sp.role : null;
  };

  for (const [key, name] of sections) {
    const points = d.points.filter((p) => p.section === key);
    if (!points.length) continue;
    lines.push('', name.toUpperCase());
    for (const p of points) {
      const tags = [p.corner_code, p.phase ? PHASE[p.phase] ?? p.phase : null].filter(Boolean).join(' ');
      const by = who(p.speaker);
      lines.push(`- ${tags ? `[${tags}] ` : ''}${p.text.trim()}${by ? ` (${by})` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Links for when the phone or browser has no share sheet: WhatsApp's own link and a new email. */
export function shareLinks(text: string, subject: string) {
  return {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(text)}`,
    email: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`,
  };
}
