// The time left of an upload, for its progress (components/ImportLogs.tsx): while the files go out, from the speed
// they have been going at over the last few seconds; once the server has them, from how fast it imported the past
// uploads (server/app/import_rates.py: GET /imports/rates before the job exists, the job's own `eta` after). The
// number shown is smoothed: it counts down with the clock, follows a lower estimate at once, and goes up only when a
// clearly higher one has held for a few seconds. Nothing here reaches the server (lib/importRates.ts does), so the
// tests run it as it is (uploadEta.test.mjs).

/** How fast the server imports (GET /imports/rates), as server/app/import_rates.py Rates. */
export type Rates = {
  receive_s_per_mb: number; // taking the upload in once it has been sent, per MB sent
  unpack_s: number; // finding the logs in it
  zip_expansion: number; // MB of logs in each MB of zip
  check_s_per_mb: number; // checking the logs against those in the app, per MB of log
  log_s: number; // reading a log: this much for each ...
  log_s_per_mb: number; // ... and this much for each MB of it
  mean_log_mb: number; // a log's size on average
  finish_s: number; // after the last log
  measured?: number;
};

/** The server's guesses before it has imported anything (server/app/import_rates.py FALLBACK). */
export const FALLBACK_RATES: Rates = {
  receive_s_per_mb: 0.02, unpack_s: 1, zip_expansion: 9, check_s_per_mb: 0.04, log_s: 2, log_s_per_mb: 0.3,
  mean_log_mb: 25, finish_s: 2,
};

/** sending and receiving are the app's own; the others the server's (the job's `eta.stage`). */
export type Stage = 'sending' | 'receiving' | 'waiting' | 'unpacking' | 'checking' | 'logs';
/** Seconds left of the stage the upload is at and of all of it; null while there's no telling yet. */
export type Eta = { stage: Stage; stage_s: number | null; total_s: number | null };

const MB = 1e6;

export const STAGE_NAMES: Record<Stage, string> = {
  sending: 'Sending',
  receiving: 'Taking it in',
  waiting: 'Waiting for the server',
  unpacking: 'Unpacking',
  checking: 'Checking for logs already uploaded',
  logs: 'Reading the logs',
};

/** Seconds the server takes for an upload once it has it, before its logs are known (import_rates.before()): finding
 * the logs, checking them, reading them (as many as an upload of this size holds) and finishing. A zip holds about
 * zip_expansion times its size in logs. */
export function serverSeconds(r: Rates, uploadBytes: number, zipBytes: number): number {
  const logMb = Math.max(0, uploadBytes - zipBytes) / MB + (zipBytes / MB) * r.zip_expansion;
  const logs = Math.max(1, logMb / Math.max(r.mean_log_mb, 0.1));
  return r.unpack_s + logMb * r.check_s_per_mb + logs * r.log_s + logMb * r.log_s_per_mb + r.finish_s;
}

/** While the files go out: the rest at the speed they have been going at, then the server's part. */
export function whileSending(r: Rates, s: { loaded: number; total: number; zipBytes: number; bytesPerS: number | null }): Eta {
  const after = r.receive_s_per_mb * (s.total / MB) + serverSeconds(r, s.total, s.zipBytes);
  if (s.bytesPerS == null || s.bytesPerS <= 0) return { stage: 'sending', stage_s: null, total_s: null };
  const left = Math.max(0, s.total - s.loaded) / s.bytesPerS;
  return { stage: 'sending', stage_s: left, total_s: left + after };
}

/** Sent, the server taking it in (it answers with the import job when it has). */
export function whileReceiving(r: Rates, s: { total: number; zipBytes: number; sinceSentS: number }): Eta {
  const left = Math.max(0, r.receive_s_per_mb * (s.total / MB) - s.sinceSentS);
  return { stage: 'receiving', stage_s: left, total_s: left + serverSeconds(r, s.total, s.zipBytes) };
}

/** The speed the files are going out at: smoothed over the last several seconds (an exponential average with a time
 * constant of TAU_S), not the speed of the last moment. Fed the bytes sent so far, with the time in ms; fed the same
 * number again when nothing has moved, so a stalled upload slows down. */
export class SendSpeed {
  static TAU_S = 8;
  static FIRST_MS = 1500; // the first figure: the mean speed of the first moments
  private rate: number | null = null;
  private first: { loaded: number; at: number } | null = null;
  private last: { loaded: number; at: number } | null = null;

  add(loaded: number, at: number): void {
    if (!this.first || !this.last) {
      this.first = this.last = { loaded, at };
      return;
    }
    const dt = (at - this.last.at) / 1000;
    if (dt < 0.2) return; // the browser tells every few ms: a step of at least 0.2 s
    if (this.rate == null) {
      if (at - this.first.at >= SendSpeed.FIRST_MS) this.rate = (loaded - this.first.loaded) / ((at - this.first.at) / 1000);
    } else {
      const now = Math.max(0, loaded - this.last.loaded) / dt;
      this.rate += (1 - Math.exp(-dt / SendSpeed.TAU_S)) * (now - this.rate);
    }
    this.last = { loaded, at };
  }

  get bytesPerS(): number | null {
    return this.rate;
  }
}

/** The number shown, from estimates that come and go: it counts down with the clock between them, follows a lower
 * estimate at once, holds still while the estimate is a little higher, and goes up only when the estimate has been
 * more than RISE above it (and a couple of seconds more) for RISE_MS. */
export class Smoother {
  static RISE = 1.2;
  static RISE_MS = 3000;
  private shown: number | null = null;
  private at = 0;
  private highSince: number | null = null;

  /** The number to show at `now` (ms), given the latest estimate (null: none yet, the shown one counts down). */
  update(estimate: number | null, now: number): number | null {
    if (this.shown == null) {
      if (estimate == null || !Number.isFinite(estimate)) return null;
      this.shown = Math.max(0, estimate);
      this.at = now;
      return this.shown;
    }
    const counted = Math.max(0, this.shown - Math.max(0, now - this.at) / 1000);
    let next = counted;
    if (estimate != null && Number.isFinite(estimate)) {
      const e = Math.max(0, estimate);
      if (e > counted * Smoother.RISE + 2) {
        this.highSince ??= now;
        if (now - this.highSince >= Smoother.RISE_MS) {
          next = e;
          this.highSince = null;
        } else {
          next = Math.min(e, this.shown); // held, not counted down, while it is confirmed
        }
      } else {
        this.highSince = null;
        next = e <= counted ? e : Math.min(e, this.shown); // lower: at once; a little higher: held still
      }
    }
    this.shown = next;
    this.at = now;
    return next;
  }
}

/** "about 40 s left", "about 2 min left", "almost done": to 5 s under a minute, to the minute above, and no counting
 * down the last ALMOST_S seconds. null: no telling yet. */
export const ALMOST_S = 10;
export function leftWords(s: number | null): string | null {
  if (s == null || !Number.isFinite(s)) return null;
  if (s <= ALMOST_S) return 'almost done';
  const five = Math.round(s / 5) * 5;
  if (five < 60) return `about ${five} s left`;
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `about ${min} min left`;
  const steps = Math.round(min / 5) * 5; // over an hour, to 5 min
  const m = steps % 60;
  return `about ${Math.floor(steps / 60)} h${m ? ` ${m} min` : ''} left`;
}

/** The two lines under the bar: the whole upload ("About 2 min left") and the stage it is at ("Sending: about 40 s
 * left"); the last stage, reading the logs, is the rest of the upload, so its line names it without a second number. */
export function etaLines(stage: Stage, stageS: number | null, totalS: number | null): { total: string; stage: string } {
  const all = leftWords(totalS);
  const name = STAGE_NAMES[stage];
  const total = all ? all[0].toUpperCase() + all.slice(1) : 'Working out the time left';
  if (stage === 'logs') return { total, stage: `${name}, the last step` };
  const part = leftWords(stageS);
  return { total, stage: part ? `${name}: ${part}` : name };
}

/** One upload's time left, from its first byte to the end of its import: told what happens (sent(), job()) and asked
 * every second or so what to show (at()). Times are ms (Date.now()). */
export class UploadEta {
  private rates: Rates;
  private speed = new SendSpeed();
  private total = new Smoother();
  private stage = new Smoother();
  private stageNow: Stage | null = null;
  private sending = { loaded: 0, total: 0, zipBytes: 0 };
  private sentAt: number | null = null;
  private server: { eta: Eta | null; at: number } | null = null;

  constructor(rates: Rates = FALLBACK_RATES) {
    this.rates = rates;
  }

  setRates(r: Rates): void {
    this.rates = r;
  }

  /** The files going out: bytes sent of the total, the zips' share of it. */
  sent(loaded: number, total: number, zipBytes: number, now: number): void {
    this.sending = { loaded, total, zipBytes };
    this.speed.add(loaded, now);
    if (total > 0 && loaded >= total) this.sentAt ??= now;
  }

  /** The import job's own estimate, as the server last gave it (null: it gave none). */
  job(eta: Eta | null | undefined, now: number): void {
    this.server = { eta: eta ?? null, at: now };
  }

  /** What to show now: the stage, and the seconds left of it and of the whole upload, smoothed. */
  at(now: number): Eta {
    const raw = this.estimate(now);
    if (raw.stage !== this.stageNow) {
      this.stageNow = raw.stage;
      this.stage = new Smoother(); // each stage's own count, from its own first estimate
    }
    return { stage: raw.stage, stage_s: this.stage.update(raw.stage_s, now), total_s: this.total.update(raw.total_s, now) };
  }

  private estimate(now: number): Eta {
    const s = this.sending;
    if (this.server) { // the server's figures, less the time since it gave them
      const e = this.server.eta;
      const gone = (now - this.server.at) / 1000;
      const less = (x: number | null) => (x == null ? null : Math.max(0, x - gone));
      return e ? { stage: e.stage, stage_s: less(e.stage_s), total_s: less(e.total_s) } : { stage: 'logs', stage_s: null, total_s: null };
    }
    if (this.sentAt != null) {
      return whileReceiving(this.rates, { total: s.total, zipBytes: s.zipBytes, sinceSentS: (now - this.sentAt) / 1000 });
    }
    this.speed.add(s.loaded, now); // nothing has moved since the last report: the speed drops
    return whileSending(this.rates, { ...s, bytesPerS: this.speed.bytesPerS });
  }
}
