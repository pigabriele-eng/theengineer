// Client for the The Engineer server (see /server). Set EXPO_PUBLIC_API_URL to point at a deployed server.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';

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
  reference_lap: number;
  length_m: number;
  theoretical_best: number;
  corners: { code: string; apex_m: number; best_lap: number; laps: Record<string, CornerMetrics> }[];
};

export type DebriefPointIn = { section: string; text: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
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
  uploadFile: (id: number, file: { uri: string; name: string; file?: File }) => {
    const form = new FormData();
    // On web the picker hands us a File; on iOS FormData takes a { uri, name, type } descriptor.
    form.append('file', file.file ?? ({ uri: file.uri, name: file.name, type: 'application/octet-stream' } as any));
    return request<SessionDetail>(`/sessions/${id}/files`, { method: 'POST', body: form });
  },
  createDebrief: (id: number, points: DebriefPointIn[]) =>
    request(`/sessions/${id}/debriefs`, json({ mode: 'individual', points })),
};

export const formatLap = (s: number | null | undefined) => {
  if (s == null) return '–';
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(2).padStart(5, '0');
  return m ? `${m}:${rest}` : s.toFixed(2);
};
