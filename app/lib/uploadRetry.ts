// An upload sent again when a server restart cuts it off (lib/upload.ts). Each deploy restarts the server, and Render's
// free plan stops and starts it: an upload in flight then ends with no answer (the browser's onerror) or a gateway
// error from Render's proxy. The files are sent again after a wait, a few times, long enough for the server to be
// back; logs it took in already are left out by the server (already uploaded). Pure, so `npm test` checks it.

export const RETRY_WAITS_S = [10, 20, 30, 60];
export const GATEWAY = new Set([502, 503, 504]); // the server restarting, behind Render's proxy
export const CUT = 'The upload was cut off: check the connection and try again.';

/** An upload being sent again: attempt (2 for the first retry) of `of`, after waiting `wait_s`. */
export type Retry = { attempt: number; of: number; wait_s: number };

/** send() until it answers with anything but a gateway error, or it has been tried 1 + waits.length times: cut off
 * (an Error with the CUT message) or a gateway error is tried again after the next wait; any other error is thrown at
 * once. The last answer (a gateway error too) is handed back, or the last cut-off thrown. */
export async function withRetries<T extends { status: number }>(send: () => Promise<T>, onRetry: (r: Retry | null) => void,
  waits: number[] = RETRY_WAITS_S, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: T | null = null;
    let cut: Error | null = null;
    try {
      res = await send();
    } catch (e) {
      if ((e as Error).message !== CUT) throw e;
      cut = e as Error;
    }
    if (res && !GATEWAY.has(res.status)) {
      onRetry(null);
      return res;
    }
    if (attempt >= waits.length) {
      onRetry(null);
      if (cut) throw cut;
      return res!;
    }
    onRetry({ attempt: attempt + 2, of: waits.length + 1, wait_s: waits[attempt] });
    await sleep(waits[attempt] * 1000);
  }
}
