// The library down the left: tracks, the events at each (newest first), and each event's official sessions (FP1,
// Q1, R1...; a log folder's name when the runs aren't named from the timetable). The newest session opens on its own.
import { useEffect, useState } from 'react';

import { get } from '../api';
import type { Library as LibraryAnswer, LibraryEvent, SessionAnswer, SessionChoice } from '../api';
import { eventLabel, lapTime } from '../board';
import type { Pick } from './Board';

export function Library({ library, pick, onPick }: {
  library: LibraryAnswer | null;
  pick: Pick | null;
  onPick: (p: Pick, title: string) => void;
}) {
  const [openTracks, setOpenTracks] = useState<Set<string>>(new Set());
  const [sessions, setSessions] = useState<Record<number, { list: SessionChoice[]; latest: string | null }>>({});

  const load = async (e: LibraryEvent) => {
    if (sessions[e.id]) return sessions[e.id];
    const got = await get<SessionAnswer>(`/events/${e.id}/latest-session/sections`);
    const entry = { list: got.sessions ?? [], latest: got.latest ?? got.session?.code ?? null };
    setSessions((s) => ({ ...s, [e.id]: entry }));
    return entry;
  };

  // the newest event's latest session, when nothing is open yet
  useEffect(() => {
    const first = library?.tracks[0];
    const e = first?.events[0];
    if (!library || !first || !e) return;
    setOpenTracks((o) => (o.size ? o : new Set([first.name ?? ''])));
    if (!pick) {
      void load(e).then((s) => onPick({ eventId: e.id, part: s.latest }, title(first.name, e)));
    } else {
      void load(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library]);

  if (!library) return <div className="lib-head muted">Reading the library…</div>;
  if (!library.tracks.length) return <div className="lib-head muted">Nothing imported yet.</div>;

  return (
    <nav aria-label="Library">
      {library.tracks.map((t) => {
        const key = t.name ?? '';
        const isOpen = openTracks.has(key);
        return (
          <div className="lib-track" key={key}>
            <button aria-expanded={isOpen} onClick={() => {
              const next = new Set(openTracks);
              if (isOpen) next.delete(key); else next.add(key);
              setOpenTracks(next);
              if (!isOpen) t.events.forEach((e) => void load(e));
            }}>
              <span>{t.name ?? 'Track not known'}</span><span aria-hidden>{isOpen ? '−' : '+'}</span>
            </button>
            {isOpen && t.events.map((e) => (
              <div className="lib-event" key={e.id}>
                <button onClick={() => void load(e)}>
                  {eventLabel(e.name, e.series, e.date)}
                  <small>{e.date ?? ''}{e.best ? ` · best ${lapTime(e.best)}` : ''}{e.videos ? ` · ${e.videos} video${e.videos > 1 ? 's' : ''}` : ''}</small>
                </button>
                {(sessions[e.id]?.list ?? []).slice().reverse().map((s) => {
                  const current = pick?.eventId === e.id && (pick.part ?? sessions[e.id]?.latest) === s.code;
                  return (
                    <button key={s.code} className="lib-session" aria-current={current ? 'true' : undefined}
                      onClick={() => onPick({ eventId: e.id, part: s.code }, title(t.name, e))}>
                      <span>{s.title}</span><span className="num">{s.laps} laps</span>
                      <small>{s.drivers.length ? s.drivers.join(', ') : `${s.runs.length} ${s.runs.length === 1 ? 'stint' : 'stints'}`}</small>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })}
    </nav>
  );
}

export const title = (track: string | null, e: LibraryEvent) =>
  `${track ?? 'Track not known'} · ${eventLabel(e.name, e.series, e.date)}`;
