// Recording a debrief in the browser, without expo-audio's web recorder: that one waits for the browser's last
// piece of sound with no time limit, so when the phone never sends it (iPhone Safari while it also writes the words
// down) "Stop and send" did nothing (Gabriele, 2026-10-09). Here the sound is collected every second while it records,
// a stop never waits more than a few seconds, and the recording can be paused and carried on (one debrief in several
// parts) or thrown away. The pure parts are checked by `npm test` (lib/webRecorder.test.mjs) with a stand-in recorder.

/** The browser's recorder, as much of it as is used here (MediaRecorder). */
export type MediaRecorderLike = {
  state: 'inactive' | 'recording' | 'paused';
  mimeType?: string;
  start(timeslice?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  addEventListener(type: string, fn: (e: any) => void): void;
};

/** The first sound format the browser records: WebM in Chrome and Android, MP4 (AAC) on iPhone. */
export function pickMime(isSupported: (type: string) => boolean): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus'].find((t) => {
    try {
      return isSupported(t);
    } catch {
      return false;
    }
  });
}

/** The file ending the server knows the recording by (server/app/routers/debriefs.py AUDIO). */
export function extFor(type: string | undefined): string {
  const t = (type ?? '').toLowerCase();
  if (t.includes('mp4') || t.includes('aac') || t.includes('m4a')) return '.m4a';
  if (t.includes('ogg')) return '.ogg';
  if (t.includes('wav')) return '.wav';
  return '.webm';
}

/** A second of silence as a WAV file: sent in place of a recording the phone gave no sound for, so the words it wrote
 * down still make a debrief. */
export function silentWav(seconds = 1, rate = 8000): Uint8Array {
  const samples = Math.round(seconds * rate);
  const out = new Uint8Array(44 + samples * 2);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, samples * 2, true);
  return out;
}

/** How long a stop waits for the browser's last piece of sound before it goes with what it has. */
export const STOP_WAIT_MS = 3000;

/** One recording, paused and carried on as often as wanted, stopped once. */
export class WebRecorder {
  private chunks: Blob[] = [];
  private ran = 0; // ms recorded before the current part
  private since: number | null = null; // when the current part started
  private stopping = false;
  /** The browser stopped recording by itself (the microphone taken away, the page put away too long). */
  ended = false;
  onEnded: (() => void) | null = null;

  private readonly mr: MediaRecorderLike;
  private readonly release: () => void;
  private readonly now: () => number;

  constructor(mr: MediaRecorderLike, release: () => void = () => {}, now: () => number = Date.now) {
    this.mr = mr;
    this.release = release;
    this.now = now;
    mr.addEventListener('dataavailable', (e) => {
      if (e?.data && e.data.size > 0) this.chunks.push(e.data);
    });
    mr.addEventListener('stop', () => {
      this.hold();
      if (!this.stopping) {
        this.ended = true;
        this.release();
        this.onEnded?.();
      }
    });
  }

  /** Asks for the microphone and makes a recorder for it; throws when the browser can't record. */
  static async open(): Promise<WebRecorder> {
    const MR = (globalThis as any).MediaRecorder;
    if (!MR || !navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot record sound.');
    const stream: MediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMime((t) => MR.isTypeSupported?.(t) ?? false);
    let mr: MediaRecorderLike;
    try {
      mr = new MR(stream, mimeType ? { mimeType } : undefined);
    } catch {
      mr = new MR(stream);
    }
    return new WebRecorder(mr, () => stream.getTracks().forEach((t) => t.stop()));
  }

  private hold() {
    if (this.since != null) this.ran += this.now() - this.since;
    this.since = null;
  }

  get state(): 'recording' | 'paused' | 'ended' {
    if (this.ended) return 'ended';
    return this.mr.state === 'recording' ? 'recording' : 'paused';
  }

  /** Milliseconds recorded so far, the pauses left out. */
  get ms(): number {
    return this.ran + (this.since != null ? this.now() - this.since : 0);
  }

  start() {
    this.mr.start(1000); // a piece of sound every second, so a stop has nearly all of it already
    this.since = this.now();
  }

  pause() {
    if (this.mr.state !== 'recording') return;
    try {
      this.mr.pause();
    } finally {
      this.hold();
    }
  }

  /** Carries on after a pause; false when the browser already ended the recording. */
  resume(): boolean {
    if (this.ended || this.mr.state !== 'paused') return false;
    this.mr.resume();
    this.since = this.now();
    return true;
  }

  /** Stops and gives the sound recorded (empty when the phone gave none). Never waits more than STOP_WAIT_MS. */
  async finish(wait = STOP_WAIT_MS): Promise<Blob> {
    this.stopping = true;
    if (this.mr.state !== 'inactive') {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, wait);
        this.mr.addEventListener('stop', () => {
          clearTimeout(timer);
          done();
        });
        try {
          this.mr.stop();
        } catch {
          clearTimeout(timer);
          done();
        }
      });
    }
    this.hold();
    this.release();
    const type = this.chunks[0]?.type || this.mr.mimeType || 'audio/webm';
    return new Blob(this.chunks, { type });
  }

  /** Stops and throws the sound away. */
  discard() {
    this.stopping = true;
    try {
      if (this.mr.state !== 'inactive') this.mr.stop();
    } catch {
      // already stopped
    }
    this.hold();
    this.release();
    this.chunks = [];
  }
}
