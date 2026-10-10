// A debrief's transcript as it is read and edited. The server keeps it one line per stretch of speech, each starting
// with its speaker ("S0: ..."); shown as stored, a driver alone got "Driver:" in front of every sentence, which
// "confuses the read" (Gabriele, 2026-10-09). Read here as flowing text: no speaker names when one person speaks,
// and with several only where the speaker changes. Checked by `npm test` (lib/transcriptText.test.mjs).

type Speakers = Record<string, { name?: string | null; role?: string | null }> | null | undefined;

const LINE = /^\s*(S\d+)\s*:\s*(.*)$/;

/** The stored lines with their speaker; a line with no label keeps the speaker before it. */
function lines(transcript: string): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  let key = 'S0';
  for (const raw of transcript.split('\n')) {
    const m = LINE.exec(raw);
    const text = (m ? m[2] : raw).trim();
    if (m) key = m[1];
    if (text) out.push({ key, text });
  }
  return out;
}

const who = (key: string, speakers: Speakers) => {
  const sp = speakers?.[key];
  const name = sp?.name || sp?.role;
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : `Speaker ${Number(key.slice(1)) + 1}`;
};

/** Paragraphs to read: one per turn of speech, named only when more than one person speaks. */
export function readable(transcript: string, speakers?: Speakers): { who: string | null; text: string }[] {
  const all = lines(transcript);
  const many = new Set(all.map((l) => l.key)).size > 1;
  const out: { key: string; who: string | null; text: string }[] = [];
  for (const l of all) {
    const last = out[out.length - 1];
    if (last && last.key === l.key) last.text += ` ${l.text}`;
    else out.push({ key: l.key, who: many ? who(l.key, speakers) : null, text: l.text });
  }
  return out.map(({ who: w, text }) => ({ who: w, text }));
}

/** The text to edit: still one line per stretch of speech (each keeps its place in the recording when saved), the
 * speaker written only where it changes, which the server reads back the same way (debrief/pipeline.py from_text). */
export function editable(transcript: string): string {
  const all = lines(transcript);
  const many = new Set(all.map((l) => l.key)).size > 1;
  return all.map((l, i) => (many && (i === 0 || all[i - 1].key !== l.key) ? `${l.key}: ${l.text}` : l.text)).join('\n');
}
