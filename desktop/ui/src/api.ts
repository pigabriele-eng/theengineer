// The analysis server on this computer (server/, started by desktop/main.js) and what the desktop app itself can do
// (desktop/preload.js): pick folders and videos, save the page as a PDF for the phone, watch a folder for new files.
// Outside the desktop app (npm run dev) the server is asked at VITE_API or 127.0.0.1:8765 and the desktop's own
// abilities are missing: the screens then offer a typed path instead.

export type Bridge = {
  apiUrl: string;
  savePdf: (name: string) => Promise<{ canceled?: boolean; path?: string; name?: string }>;
  showFile: (file: string) => Promise<void>;
  pickFolders?: () => Promise<string[]>;
  pickVideo?: () => Promise<string | null>;
  watchFolder?: () => Promise<string | null>;
  setWatchFolder?: () => Promise<string | null>;
  onNewFiles?: (cb: (paths: string[]) => void) => () => void;
  openClassic?: (path: string) => Promise<void>;
};

export const bridge: Bridge | undefined = (window as unknown as { theEngineerDesktop?: Bridge }).theEngineerDesktop;
export const API: string = bridge?.apiUrl ?? (import.meta.env.VITE_API as string | undefined) ?? 'http://127.0.0.1:8765';

async function answer<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = (body as { detail?: unknown }).detail;
    throw new Error(typeof detail === 'string' ? detail : `The app's analysis answered ${res.status}`);
  }
  return (res.status === 204 ? null : res.json()) as Promise<T>;
}

export const get = <T>(path: string) => fetch(`${API}${path}`).then((r) => answer<T>(r));
const send = <T>(method: string, path: string, body?: unknown) => fetch(`${API}${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => answer<T>(r));
export const post = <T>(path: string, body?: unknown) => send<T>('POST', path, body);
export const put = <T>(path: string, body?: unknown) => send<T>('PUT', path, body);
export const del = (path: string) => send<null>('DELETE', path);

/** Asked again every `ms` while the answer says it is still being worked out. */
export async function until<T extends { status?: string }>(ask: () => Promise<T>, onPart?: (t: T) => void,
  ms = 1500, tries = 200): Promise<T> {
  for (let i = 0; ; i++) {
    const got = await ask();
    if (got.status !== 'working' || i >= tries) return got;
    onPart?.(got);
    await new Promise((r) => setTimeout(r, ms));
  }
}

/** Where a linked video plays from: the server streams it from where it is on the computer. */
export const videoSrc = (id: number) => `${API}/desktop/videos/${id}/file`;

// ---------- what the server answers ----------

export type LibraryRun = { id: number; name: string | null; driver: string | null; laps: number; best: number | null;
  logger: string | null; videos: number; date: string | null };
export type LibraryEvent = { id: number; name: string; series: string | null; date: string | null; track: string | null;
  runs: LibraryRun[]; videos: number; best: number | null; loggers: string[] };
export type Library = { tracks: { name: string | null; events: LibraryEvent[] }[]; loose: LibraryRun[] };

export type LapKind = 'out' | 'build' | 'in' | 'slow';
export type SessionLap = { number: number; time: number; clean?: boolean; kind?: LapKind | null;
  sections: (number | null)[] | null };
export type SessionRun = { id: number; name: string; short: string; driver: string | null; driver_id: number | null;
  laps: SessionLap[] };
export type SessionSection = { code: string; start_m: number; end_m: number; apex_m: number | null; corners: string[] };
export type SessionChoice = { code: string; title: string; laps: number; drivers: string[];
  runs: { id: number; name: string; short: string; driver: string | null; laps: number }[] };
export type SessionAnswer = {
  event_id: number; status: 'ready' | 'working' | 'empty'; session: { code: string; title: string } | null;
  runs: SessionRun[]; fastest: { session_id: number; lap: number; time: number } | null;
  sections: SessionSection[] | null; numbering: 'official' | 'detected' | null; note: string | null;
  sessions?: SessionChoice[]; latest?: string | null;
};

export type LapRef = { session_id: number; lap: number };
export type Tip = { code: string; from: [string, number]; versus: [string, number]; gain_s: number; phase: string;
  phase_s: number; does: string[]; also: string[] };
export type Theoretical = { time: number; gap_s: number; best_run: string; best_lap: number; best_time: number;
  laps: number; from: [string, number][]; gains?: number[]; tips?: Tip[] };
export type StintTheoretical = { run: string; session_id: number; session: string; driver: string | null;
  ready: boolean } & Partial<Theoretical>;
export type TheoreticalAnswer = { sections: string[]; stints: StintTheoretical[]; combined: Theoretical | null };

export type Trace = { t: number[]; speed?: number[]; throttle?: number[]; brake?: number[]; steer?: number[];
  gear?: number[] };
export type Difference = { metric: string; text: string };
export type CompareAnswer = {
  laps: { session_id: number; session: string; driver: string | null; lap: number; time: number }[];
  sections: { code: string; start_m: number; end_m: number; apex_m: number | null; corners: string[]; times: number[];
    best: number }[];
  opportunities: { to_ideal: number; sections: { code: string; loss_s: number; versus: number; phase: string;
    where_m: [number, number]; differences: Difference[] }[] }[];
  traces: { step_m: number; distance: number[]; laps: Trace[]; roles: string[] };
};

export type TrackMapAnswer = { x: number[]; y: number[]; length_m: number; step_m: number; clockwise: boolean;
  numbering: string; corners: { code: string; apex_m: number; x: number; y: number }[];
  sections: { code: string; start_m: number; end_m: number; corners: string[] }[];
  start: { x: number; y: number; dx: number; dy: number } };

export type Video = { id: number; session_id: number; path: string; name: string; start: number | null;
  method: string | null; score: number | null; duration: number | null; camera: string | null; exists: boolean };
export type RunLaps = { id: number; name: string | null; driver: string | null; logger: string | null;
  laps: { number: number; start: number; time: number; clean: boolean }[]; videos: Video[] };

export type ImportJob = { id: number; status: string; done: number; total: number; current: string | null;
  message: string | null; errors: { file: string; error: string }[];
  videos?: { linked: Video[]; unmatched: string[] } };
