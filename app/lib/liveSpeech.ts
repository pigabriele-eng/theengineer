// Speech to text in the browser while a debrief is recorded (the Web Speech API), so the words go with the recording
// and no paid speech to text is needed. Chrome, Edge and Safari have it; Firefox does not. The recording itself never
// depends on it: every call here is wrapped so a failing recogniser only means no live words.
// The pure parts (language, stamping segments) are checked by `npm test` (lib/liveSpeech.test.mjs).

/** One phrase heard, in seconds from the start of the recording. */
export type LiveSegment = { start: number; end: number; text: string };

/** The recogniser's language for the debrief language picked; Mixed takes the browser's own. */
export function speechLang(language: string, browser?: string): string {
  switch (language) {
    case 'en': return 'en-GB';
    case 'it': return 'it-IT';
    case 'de': return 'de-DE';
    default: return browser || 'en-GB';
  }
}

/** What has been heard so far. `done`: final results handled in the recogniser's current run (it starts again from
 * 0 after each restart); `phraseStart`: when the phrase being heard began (its first interim words), if any. */
export type Heard = { finals: LiveSegment[]; done: number; phraseStart: number | null; lastEnd: number };

export const heardNothing = (): Heard => ({ finals: [], done: 0, phraseStart: null, lastEnd: 0 });

const round = (s: number) => Math.round(s * 100) / 100;

/** Folds one result event in: each new final becomes a segment from when its phrase began (its first interim words,
 * else the end of the previous one) to `now`; the rest is the interim text. `results`: the run's whole list. */
export function hear(h: Heard, results: { final: boolean; text: string }[], now: number): { heard: Heard; interim: string } {
  const finals = [...h.finals];
  let { done, phraseStart, lastEnd } = h;
  const interim: string[] = [];
  for (let i = done; i < results.length; i++) {
    const r = results[i];
    const text = r.text.trim();
    if (r.final) {
      done = i + 1;
      if (text) {
        finals.push({ start: round(Math.min(phraseStart ?? lastEnd, now)), end: round(now), text });
        lastEnd = now;
      }
      phraseStart = null;
    } else if (text) {
      interim.push(text);
      if (phraseStart == null) phraseStart = now;
    }
  }
  return { heard: { finals, done, phraseStart, lastEnd }, interim: interim.join(' ') };
}

/** After a restart the recogniser's list starts empty again; a phrase cut off mid-way is dropped. */
export const restarted = (h: Heard): Heard => ({ ...h, done: 0, phraseStart: null });

type Recogniser = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

const ctor = (): (new () => Recogniser) | null => {
  try {
    if (typeof window === 'undefined') return null;
    const w = window as any;
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
  } catch {
    return null;
  }
};

/** Whether this browser can write down speech. */
export const speechSupported = (): boolean => ctor() != null;

/** Starts listening; `onUpdate` gets the phrases so far and the words being heard. `stop()` ends it and gives the
 * phrases. Never throws: without a recogniser, or when it fails, it hears nothing. */
export function startLiveSpeech(
  lang: string,
  startedAtMs: number,
  onUpdate: (finals: LiveSegment[], interim: string) => void,
): { stop(): LiveSegment[] } {
  let heard = heardNothing();
  let stopped = false;
  const C = ctor();
  if (!C) return { stop: () => [] };
  let r: Recogniser;
  try {
    r = new C();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
  } catch {
    return { stop: () => [] };
  }
  const elapsed = () => Math.max(0, (Date.now() - startedAtMs) / 1000);
  r.onresult = (e: any) => {
    try {
      const list = e?.results ?? [];
      const results: { final: boolean; text: string }[] = [];
      for (let i = 0; i < list.length; i++) results.push({ final: !!list[i].isFinal, text: list[i][0]?.transcript ?? '' });
      const out = hear(heard, results, elapsed());
      heard = out.heard;
      onUpdate(heard.finals, out.interim);
    } catch {
      // a bad event only loses those words
    }
  };
  r.onerror = (e: any) => {
    // no-speech and aborted come with silences and restarts; not-allowed (or no microphone): stop quietly
    const err = e?.error;
    if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') stopped = true;
  };
  r.onend = () => {
    // Chrome and iOS Safari end after a silence or about a minute: listen again until stopped
    if (stopped) return;
    heard = restarted(heard);
    try {
      r.start();
    } catch {
      stopped = true;
    }
  };
  try {
    r.start();
  } catch {
    stopped = true;
  }
  return {
    stop() {
      stopped = true;
      try {
        r.stop();
      } catch {
        // already ended
      }
      return heard.finals;
    },
  };
}
