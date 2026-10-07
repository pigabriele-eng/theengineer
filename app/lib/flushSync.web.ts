// React DOM's flushSync on the web: the update in `fn` is drawn before it returns (lib/print.ts draws the page Light
// and lays it out on paper within the tap that prints it). lib/flushSync.ts is the same call on iOS and Android.
const dom = require('react-dom') as { flushSync<R>(fn: () => R): R };

export function flushSync<R>(fn: () => R): R {
  return dom.flushSync(fn);
}
