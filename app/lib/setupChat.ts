// Client for the setup tool (server/app/routers/setup_chat.py): a conversation per event that proposes one setup
// change at a time and remembers what can't go further ("already at the minimum ride height").
import { apiFetch } from '@/lib/api';

export type Limit = { row: string; axle: 'front' | 'rear' | null; want: string };
export type ChatAction = { type: string; [k: string]: unknown };
export type QuickReply = { label: string; action: ChatAction };

export type Change = {
  lever: string;
  title: string;
  changes: string[]; // "Anti-roll bar front 3 → 2", or a step when the run has no sheet
  why: string;
  expected: string;
  watch: string;
  another_way: boolean;
  history?: { times: number; text: string }; // what the logged runs say about this change
  car?: string; // what is known about the adjustment on this car (and what is not)
  on_run?: string; // the run it was tried on, when the tool is reporting what it did
};

export type ChatMessage = { from: 'you' | 'tool'; text: string; at: string; change?: Change };

export type SetupChat = {
  event_id: number | null;
  event: string | null;
  runs: { id: number; name: string; debrief: boolean; data: boolean }[];
  session_id: number | null;
  variant: string;
  variant_label: string;
  variants: { key: string; label: string }[];
  current: Change | null;
  messages: ChatMessage[];
  limit_labels: (Limit & { label: string })[];
  pending_titles: string[]; // changes being tried on the next run, logged on it when its logs come in
  problem_labels: { kind: string; phase: string | null; label: string }[];
  quick_replies: QuickReply[];
  notes: string[];
};

async function call(path: string, init?: RequestInit): Promise<SetupChat> {
  const r = await apiFetch(path, init);
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `The setup tool failed (${r.status})`);
  return r.json();
}

export type TurnIn = {
  event_id: number | null;
  text?: string;
  action?: ChatAction;
  said?: string;
  variant?: string;
  session_id?: number | null;
  set_session?: boolean;
};

export const setupChatApi = {
  get: (eventId: number | null) => call(`/setup/chat${eventId == null ? '' : `?event_id=${eventId}`}`),
  send: (body: TurnIn) =>
    call('/setup/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
};
