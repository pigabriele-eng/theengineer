// Loading last: a heavy read that isn't the first thing a page shows (the race weekend's latest lap against the best,
// a POST that works on two laps' traces) waits until the page's other reads have answered, so it doesn't hold them up
// on the server. Every request is counted while it is on its way (lib/api.ts); `afterOthers` calls back once none
// has been for `settleMs`, or after `capMs` whatever happens. Pure, so `npm test` checks it.

let inFlight = 0;
const quiet = new Set<() => void>(); // called whenever the last request on its way has answered

/** Counts a request while it is on its way. */
export function counted<T>(p: Promise<T>): Promise<T> {
  inFlight += 1;
  const done = () => {
    inFlight -= 1;
    if (inFlight === 0) for (const f of [...quiet]) f();
  };
  p.then(done, done);
  return p;
}

/** Calls `then` once no request has been on its way for `settleMs` (or after `capMs`). Returns a stop. */
export function afterOthers(then: () => void, settleMs = 300, capMs = 10_000): () => void {
  let settle: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (settle) clearTimeout(settle);
    clearTimeout(cap);
    quiet.delete(check);
  };
  const finish = () => {
    stop();
    then();
  };
  const check = () => {
    if (settle) clearTimeout(settle);
    settle = inFlight === 0 ? setTimeout(() => inFlight === 0 && finish(), settleMs) : undefined;
  };
  const cap = setTimeout(finish, capMs);
  quiet.add(check);
  check();
  return stop;
}
