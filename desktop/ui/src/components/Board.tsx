// The session board, the first screen after the card goes in (the redesign: "the first screen after the card goes in
// already shows where the time is"): the session's quickest lap, its combined theoretical and the time on the table;
// the three corners where the laps differ most from the theoretical, each in plain words with its time worth and a
// Watch button; then every lap, section by section, the best in each marked. A corner opens the corner view.
import { useEffect, useMemo, useState } from 'react';

import { bridge, get, post, until } from '../api';
import type { LapRef, SessionAnswer, TheoreticalAnswer } from '../api';
import {
  allLaps, Corner, cornersOf, driverCode, isClean, lapTime, sectionBests, seconds, stintName, theoreticalPicks,
} from '../board';
import { CornerView } from './CornerView';

export type Pick = { eventId: number; part: string | null };

export function Board({ pick, title, onSession, onActive, onCursor, cursor, mapCorner }: {
  pick: Pick;
  title: string; // the track and event, for the heading and the PDF's name
  onSession: (s: SessionAnswer) => void;
  onActive: (code: string | null) => void; // the corner on the map
  onCursor: (metres: number | null) => void;
  cursor: number | null;
  mapCorner: { code: string; n: number } | null; // a number tapped on the map
}) {
  const [session, setSession] = useState<SessionAnswer | null>(null);
  const [theo, setTheo] = useState<TheoreticalAnswer | null>(null);
  const [theoNote, setTheoNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Corner | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSession(null); setTheo(null); setOpen(null); setError(null); setTheoNote(null);
    const q = pick.part ? `?part=${encodeURIComponent(pick.part)}` : '';
    until(() => get<SessionAnswer>(`/events/${pick.eventId}/latest-session/sections${q}`),
      (part) => { if (live) setSession(part); })
      .then((s) => { if (live) { setSession(s); onSession(s); } })
      .catch((e) => { if (live) setError(String(e.message)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick.eventId, pick.part]);

  const picks = useMemo(() => (session ? theoreticalPicks(session.runs) : []), [session]);
  useEffect(() => {
    if (picks.length < 2) return;
    let live = true;
    const ask = async (tries: number): Promise<void> => {
      try {
        const got = await post<TheoreticalAnswer>('/compare/theoretical', { laps: picks });
        if (live) setTheo(got);
      } catch (e) {
        const msg = String((e as Error).message);
        if (tries > 0 && /try again/i.test(msg)) {
          if (live) setTheoNote('The laps are being prepared for the theoretical…');
          await new Promise((r) => setTimeout(r, 4000));
          return ask(tries - 1);
        }
        if (live) setTheoNote(msg);
      }
    };
    void ask(20);
    return () => { live = false; };
  }, [picks]);

  const corners = useMemo(() => (session ? cornersOf(theo, session.runs) : []), [theo, session]);
  const bests = useMemo(() => (session ? sectionBests(session) : []), [session]);
  const codes = session?.sections?.map((s) => s.code) ?? [];

  const cornerFor = (code: string): Corner | null => {
    if (!session) return null;
    const tip = cornersOf(theo, session.runs, 99).find((c) => c.code === code);
    if (tip) return tip;
    const k = codes.indexOf(code);
    const holder = bests[k];
    const fastest = session.fastest ? { session_id: session.fastest.session_id, lap: session.fastest.lap } : null;
    if (!holder || !fastest) return null;
    const second = allLaps(session).filter(({ lap }) => isClean(lap))
      .sort((x, y) => x.lap.time - y.lap.time)
      .map(({ run, lap }) => ({ session_id: run.id, lap: lap.number }))
      .find((r) => r.session_id !== holder.session_id || r.lap !== holder.lap);
    const versus = holder.session_id === fastest.session_id && holder.lap === fastest.lap ? second : fastest;
    if (!versus) return null;
    return { code, gain: 0, phase: '', holder, versus, words: '', also: null };
  };
  const openCode = (code: string) => {
    const c = cornerFor(code);
    if (c) { setOpen(c); onActive(code); }
  };
  useEffect(() => {
    if (!mapCorner || !session?.sections) return;
    const s = session.sections.find((x) => x.code === mapCorner.code || x.corners.includes(mapCorner.code));
    if (s) openCode(s.code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapCorner?.n]);
  useEffect(() => { if (!open) onActive(corners[0]?.code ?? null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ },
    [open, corners]);

  if (error) return <p className="error">{error}</p>;
  if (!session) return <p className="muted">Opening the session…</p>;
  if (session.status === 'empty') return <p className="note">This event has no timed laps yet.</p>;
  const sessionName = session.session?.title ?? 'Session';

  if (open) {
    return <CornerView session={session} corner={open} codes={codes} onCorner={openCode}
      onBack={() => { setOpen(null); onCursor(null); }} onCursor={onCursor} cursor={cursor} />;
  }

  const fastest = session.fastest;
  const combined = theo?.combined ?? theo?.stints.find((s) => s.ready && s.time != null) ?? null;
  const drivers = [...new Set(session.runs.map((r) => driverCode(r.driver)).filter(Boolean))];
  const savePdf = async () => {
    if (!bridge) return;
    const got = await bridge.savePdf(`${title} · ${sessionName}`);
    if (got?.name) setSaved(`Saved for your phone: ${got.name}`);
  };
  const ref = (r: LapRef) => `${r.session_id}:${r.lap}`;
  const holders = new Set((theo?.combined?.from ?? []).map(([run, lap]) => `${run}:${lap}`));

  return (
    <div>
      <div className="board-head">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">{title}</div>
          <h1>{sessionName}</h1>
          <div className="muted">{session.runs.length} {session.runs.length === 1 ? 'stint' : 'stints'}
            {drivers.length ? ` · ${drivers.join(', ')}` : ''}</div>
        </div>
        <div className="figure"><span className="eyebrow">Quickest lap</span><b className="num">{lapTime(fastest?.time)}</b></div>
        <div className="figure"><span className="eyebrow">{theo?.combined ? 'Combined theoretical' : 'Stint theoretical'}</span>
          <b className="num">{lapTime(combined?.time)}</b></div>
        <div className="figure red"><span className="eyebrow">On the table</span>
          <b className="num">{combined?.gap_s != null ? seconds(combined.gap_s) : '–'}</b></div>
        <div style={{ flex: 1 }} />
        <div className="row no-print">
          {bridge?.openClassic && <>
            <button className="btn" onClick={() => void bridge!.openClassic!(`/event/${pick.eventId}?stage=stint`)}>Stint</button>
            <button className="btn" onClick={() => void bridge!.openClassic!(`/event/${pick.eventId}?stage=quali`)}>Quali</button>
          </>}
          {bridge && <button className="btn red" onClick={() => void savePdf()}>Save PDF for phone</button>}
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Where the time is</h2>
          <span className="muted">the session's laps against each other: each corner's best lap against the quickest lap</span></div>
        {corners.length === 0 && <p className="note">{theoNote ?? (picks.length < 2
          ? 'One clean lap is not enough to compare: the corners appear with two or more.' : 'Working out the theoretical…')}</p>}
        {corners.map((c) => (
          <div className="corner-row" key={c.code}>
            <span className="code">{c.code}</span>
            <span className="words">{c.words}{c.also && <small>{c.also}</small>}</span>
            <span className="worth num">{seconds(c.gain)}</span>
            <button className="btn ink no-print" onClick={() => openCode(c.code)}>Watch</button>
          </div>
        ))}
      </div>

      <div className="section">
        <div className="section-head"><h2>Every lap</h2>
          <span className="muted">green ▲ = the session's best in that corner · tap a time to open the corner with that lap</span></div>
        <div className="table-wrap">
          <table className="laps">
            <thead>
              <tr>
                <th>Lap</th><th>{session.runs.length > 1 ? 'Stint' : ''}</th><th>Time</th>
                {codes.map((c) => <th key={c}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {allLaps(session).map(({ run, lap }) => {
                const me = { session_id: run.id, lap: lap.number };
                const isFast = fastest && fastest.session_id === run.id && fastest.lap === lap.number;
                return (
                  <tr key={ref(me)} className={`${isClean(lap) ? '' : 'dim'} ${isFast ? 'fastest' : ''}`}>
                    <td><span>{lap.number}{lap.kind ? ` · ${lap.kind === 'out' ? 'out' : lap.kind === 'in' ? 'in' : lap.kind}` : ''}
                      {holders.has(`${run.id}:${lap.number}`) ? ' ◆' : ''}</span></td>
                    <td><span>{stintName(session.runs, run.id)}</span></td>
                    <td><span><b>{lapTime(lap.time)}</b></span></td>
                    {codes.map((c, k) => {
                      const t = lap.sections?.[k];
                      const best = bests[k] && ref(bests[k]!) === ref(me);
                      return (
                        <td key={c} className={best ? 'best' : undefined}>
                          {t == null ? <span>–</span> : (
                            <button aria-label={`${c} on lap ${lap.number}: ${t.toFixed(2)} seconds`} onClick={() => {
                              const base = cornerFor(c);
                              if (!base) return;
                              const versus = best ? base.versus : me;
                              setOpen({ ...base, versus, words: best ? base.words : '' }); onActive(c);
                            }}>{t.toFixed(2)}</button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {holders.size > 0 && <span className="muted">◆ = a lap the combined theoretical takes a corner from</span>}
        {session.status === 'working' && <span className="muted">Section times are still being worked out…</span>}
      </div>
      {saved && <div className="toast" role="status" onAnimationEnd={() => setSaved(null)}>{saved}</div>}
    </div>
  );
}
