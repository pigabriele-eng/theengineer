// Client for the The Engineer server (see /server). Set EXPO_PUBLIC_API_URL to point at a deployed server.
import { accessToken, authEnabled, signOut } from './auth';

// Render passes the server's bare host name (theengineer-api.onrender.com), so add https:// when there's no scheme.
const baseUrl = (process.env.EXPO_PUBLIC_API_URL ?? '').trim() || 'http://localhost:8000';
export const API_URL = (/^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`).replace(/\/+$/, '');

// Every call to the server goes through here. It adds the signed-in user's token, and a 401 (the session is gone)
// signs out, which brings back the sign-in screen.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  const headers = { ...(init.headers as Record<string, string> | undefined) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (res.status === 401 && authEnabled) {
    await signOut('Your session has ended. Please sign in again.');
  }
  return res;
}

export type SessionKind = 'test' | 'practice' | 'qualifying' | 'race';

export type Lap = { number: number; time_s: number; clean: boolean; file_id: number };

export type LoggerFile = {
  id: number;
  logger: string;
  filename: string;
  meta: { event?: string; duration_s?: number; channels?: number; mapped_channels?: Record<string, string> };
};

export type Session = {
  id: number;
  name: string | null;
  kind: SessionKind;
  created_at: string;
  best_lap_s: number | null;
};

export type SessionDetail = Session & { files: LoggerFile[]; laps: Lap[] };

export type CornerMetrics = {
  time: number;
  min_speed: number;
  brake_point?: number | null;
  peak_brake?: number;
  throttle_on?: number | null;
  full_throttle?: number | null;
};

export type Analysis = {
  file_id: number;
  reference_lap: number;
  length_m: number;
  theoretical_best: number;
  corners: { code: string; apex_m: number; best_lap: number; laps: Record<string, CornerMetrics> }[];
};

type Trace = { speed?: number[]; throttle?: number[]; brake?: number[]; steer?: number[]; gear?: number[] };

export type LapCompare = {
  reference_lap: number;
  lap: number;
  length_m: number;
  distance: number[];
  reference: Trace;
  compare: Trace;
  delta: number[];
};

export type DebriefPointIn = { section: string; text: string };

export type DebriefMode = 'individual' | 'group';
export type DebriefLanguage = 'en' | 'it' | 'de' | 'multi';
export type DebriefStatus = 'ready' | 'queued' | 'processing' | 'failed';
export type CornerPhase = 'braking' | 'entry' | 'mid' | 'exit';

export type DebriefPoint = DebriefPointIn & {
  id: number;
  speaker: string | null;
  corner_code: string | null;
  phase: CornerPhase | null;
  audio_start_s: number | null;
};

export type Debrief = {
  id: number;
  session_id: number;
  mode: DebriefMode;
  language: DebriefLanguage;
  status: DebriefStatus;
  error: string | null;
  summary: string | null;
  speakers: Record<string, { role: string; name: string | null }> | null;
  transcript: string | null;
  has_audio: boolean;
  created_at: string;
  points: DebriefPoint[];
};

// The report sections from the debrief concept, in report order (the server uses the same keys).
export const SECTIONS: [string, string][] = [
  ['balance', 'Car balance'],
  ['corners', 'Corner by corner'],
  ['tyres', 'Tyres'],
  ['brakes', 'Brakes and ABS'],
  ['electronics', 'Electronics'],
  ['traction', 'Traction and power'],
  ['ride', 'Ride and kerbs'],
  ['setup', 'Setup changes'],
  ['issues', 'Issues'],
  ['priorities', 'Driver priorities'],
];
export const sectionName = (key: string) => SECTIONS.find(([k]) => k === key)?.[1] ?? key;

export type DebriefCorner = {
  detected_code: string;
  apex_m: number;
  reference_lap: number;
  reference: CornerMetrics | null;
  best_lap: number;
  best: CornerMetrics | null;
  spread_s: number;
};

// An upload of many files at once (logs, .ldx, CSV exports, zips), imported by the server in the background.
export type ImportJob = {
  id: number;
  filename: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  total: number; // logs found; 0 until the upload is unpacked
  done: number;
  current: string | null;
  session_ids: number[];
  errors: { file: string; error: string }[];
  skipped: { file: string; reason: string }[];
  message: string | null;
};

type PickedFile = { uri: string; name: string; file?: File | Blob; mimeType?: string };

// On web we have a File or Blob; on iOS FormData takes a { uri, name, type } descriptor.
const formFile = (f: PickedFile, type: string) =>
  f.file ? (f.file instanceof File ? f.file : new File([f.file], f.name, { type: f.file.type || type }))
    : ({ uri: f.uri, name: f.name, type } as any);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  sessions: () => request<Session[]>('/sessions'),
  session: (id: number) => request<SessionDetail>(`/sessions/${id}`),
  createSession: (body: { name: string; kind: SessionKind }) => request<Session>('/sessions', json(body)),
  analysis: (id: number) => request<Analysis>(`/sessions/${id}/analysis`),
  compare: (id: number, lap: number, reference?: number) =>
    request<LapCompare>(`/sessions/${id}/compare?lap=${lap}${reference != null ? `&reference_lap=${reference}` : ''}`),
  uploadFile: (id: number, file: PickedFile) => {
    const form = new FormData();
    form.append('file', formFile(file, 'application/octet-stream'));
    return request<SessionDetail>(`/sessions/${id}/files`, { method: 'POST', body: form });
  },
  // Every file in one request; each log becomes a session. Follow the import with importJob.
  importFiles: (files: PickedFile[]) => {
    const form = new FormData();
    for (const f of files) form.append('files', formFile(f, f.mimeType || 'application/octet-stream'));
    return request<ImportJob>('/imports', { method: 'POST', body: form });
  },
  importJob: (id: number) => request<ImportJob>(`/imports/${id}`),
  createDebrief: (id: number, points: DebriefPointIn[]) =>
    request<Debrief>(`/sessions/${id}/debriefs`, json({ mode: 'individual', points })),
  recordDebrief: (id: number, audio: PickedFile, mode: DebriefMode, language: DebriefLanguage) => {
    const form = new FormData();
    form.append('audio', formFile(audio, 'audio/mp4'));
    form.append('mode', mode);
    form.append('language', language);
    return request<Debrief>(`/sessions/${id}/debriefs/audio`, { method: 'POST', body: form });
  },
  debriefs: (sessionId: number) => request<Debrief[]>(`/sessions/${sessionId}/debriefs`),
  debrief: (id: number) => request<Debrief>(`/debriefs/${id}`),
  debriefCorners: (id: number) =>
    request<{ corners: Record<string, DebriefCorner> }>(`/debriefs/${id}/corners`),
  processDebrief: (id: number) => request<Debrief>(`/debriefs/${id}/process`, { method: 'POST' }),
  // An audio player can't send headers, so when signed in the token goes in the query string.
  debriefAudioUrl: async (id: number) => {
    const token = await accessToken();
    return `${API_URL}/debriefs/${id}/audio${token ? `?access_token=${encodeURIComponent(token)}` : ''}`;
  },
};

export const formatLap = (s: number | null | undefined) => {
  if (s == null) return '–';
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(2).padStart(5, '0');
  return m ? `${m}:${rest}` : s.toFixed(2);
};
