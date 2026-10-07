// Asking the server again while it works something out, without taking its CPU from that very work: the live server
// has about a tenth of a CPU, and every answer it sends is time the job being waited on doesn't get. So a poll waits a
// little before asking again and longer each time (3.5 s, then 1.5 times longer, up to 15 s), stops after a few
// minutes, doesn't ask while the page is hidden (another tab, the window minimised), and asks at once when the page
// is back in view or the window gets the focus, starting the waits over. Nothing here reaches React or the server,
// so the tests run it as it is (poll.test.mjs).

export type PollTimes = {
  firstMs: number; // the first wait
  factor: number; // each wait this much longer than the last ...
  maxMs: number; // ... up to this
  stopAfterMs: number; // no ask starts later than this after the poll started (or came back)
};

export const POLL_TIMES: PollTimes = { firstMs: 3500, factor: 1.5, maxMs: 15000, stopAfterMs: 5 * 60_000 };

/** The wait after `prev` (null: the first one). */
export function nextWait(prev: number | null, t: PollTimes = POLL_TIMES): number {
  return prev == null ? t.firstMs : Math.min(t.maxMs, Math.round(prev * t.factor));
}

/** Every wait of a poll whose answer never comes, in order. */
export function waits(t: PollTimes = POLL_TIMES): number[] {
  const out: number[] = [];
  let total = 0;
  for (let w = nextWait(null, t); total + w <= t.stopAfterMs; w = nextWait(w, t)) {
    out.push(w);
    total += w;
  }
  return out;
}

/** Whether the page is out of view, and a way to hear that it is back. */
export type PageView = { hidden: () => boolean; onBack: (back: () => void) => () => void };

/** On the web: document.visibilityState, and the window's focus. Elsewhere (the phone app, whose timers stop with
 * the app anyway) always in view. */
export const browserPage: PageView = {
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onBack: (back) => {
    if (typeof document === 'undefined' || typeof window === 'undefined' || !window.addEventListener) return () => {};
    const shown = () => {
      if (document.visibilityState !== 'hidden') back();
    };
    document.addEventListener('visibilitychange', shown);
    window.addEventListener('focus', shown);
    return () => {
      document.removeEventListener('visibilitychange', shown);
      window.removeEventListener('focus', shown);
    };
  },
};

export type Clock = { now: () => number; later: (run: () => void, ms: number) => unknown; cancel: (handle: unknown) => void };

const realClock: Clock = {
  now: () => Date.now(),
  later: (run, ms) => setTimeout(run, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type PollOptions = Partial<PollTimes> & {
  now?: boolean; // ask at once (the default), or only after the first wait
  page?: PageView;
  clock?: Clock;
  onGiveUp?: () => void; // it stopped asking after stopAfterMs (it asks again when the page is back)
};

/** Asks now, and again after each wait while `ask` answers true (the server is still at it). Stops for good when
 * `ask` answers false or the returned stop() is called (an effect's cleanup); holds off while the page is hidden
 * and after stopAfterMs, until the page is back in view or the window gets the focus: then it asks at once and
 * starts the waits over. An `ask` that throws counts as "ask again". `live()` tells `ask` whether its answer is
 * still wanted (false once stopped), so a late answer isn't shown over a newer one. */
export function poll(ask: (live: () => boolean) => Promise<boolean> | boolean, opts: PollOptions = {}): () => void {
  const t: PollTimes = {
    firstMs: opts.firstMs ?? POLL_TIMES.firstMs,
    factor: opts.factor ?? POLL_TIMES.factor,
    maxMs: opts.maxMs ?? POLL_TIMES.maxMs,
    stopAfterMs: opts.stopAfterMs ?? POLL_TIMES.stopAfterMs,
  };
  const page = opts.page ?? browserPage;
  const clock = opts.clock ?? realClock;
  let done = false; // answered or stopped: never again
  let resting = false; // held off (hidden, or asked for long enough) until the page is back
  let timer: unknown = null;
  let wait: number | null = null;
  let since = clock.now();
  const live = () => !done;

  const finish = () => {
    done = true;
    if (timer != null) clock.cancel(timer);
    timer = null;
    off();
  };
  const next = () => {
    wait = nextWait(wait, t);
    if (clock.now() + wait - since > t.stopAfterMs) {
      resting = true;
      opts.onGiveUp?.();
    } else timer = clock.later(run, wait);
  };
  const run = async () => {
    timer = null;
    if (done) return;
    if (page.hidden()) {
      resting = true;
      return;
    }
    let again = true;
    try {
      again = await ask(live);
    } catch {
      again = true;
    }
    if (done) return;
    if (!again) finish();
    else next();
  };
  const off = page.onBack(() => {
    if (done || !resting) return;
    resting = false;
    wait = null;
    since = clock.now();
    void run();
  });

  if (opts.now === false) next();
  else void run();
  return finish;
}
