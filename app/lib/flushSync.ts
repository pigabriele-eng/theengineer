// Run `fn` (an update to draw). On the web (lib/flushSync.web.ts) React DOM draws it before this returns; iOS and
// Android never print, so there it only runs it.
export function flushSync<R>(fn: () => R): R {
  return fn();
}
