// One corner, two laps (the redesign's corner view): both onboards locked by distance on top, the traces through the
// corner below, and what to do in plain words with its time worth. Lap A is the lap that does the corner best, lap B
// the quickest real lap that loses it there; either can be changed. Arrow keys go to the corner before or after.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { get, post } from '../api';
import type { CompareAnswer, LapRef, RunLaps, SessionAnswer, SessionRun } from '../api';
import { Corner, isClean, lapTime, seconds, stintName } from '../board';
import { Traces } from './Traces';
import { VideoPair } from './VideoPair';

export function CornerView({ session, corner, codes, onCorner, onBack, onCursor, cursor }: {
  session: SessionAnswer;
  corner: Corner;
  codes: string[]; // the session's sections in order, for the arrow keys
  onCorner: (code: string) => void;
  onBack: () => void;
  onCursor: (metres: number | null) => void;
  cursor: number | null;
}) {
  const [a, setA] = useState<LapRef>(corner.holder);
  const [b, setB] = useState<LapRef>(corner.versus);
  const [cmp, setCmp] = useState<CompareAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<number, RunLaps>>({});
  const [seek, setSeek] = useState<{ metres: number; n: number } | null>(null);

  useEffect(() => { setA(corner.holder); setB(corner.versus); }, [corner]);

  useEffect(() => {
    let live = true;
    setCmp(null);
    setError(null);
    if (a.session_id === b.session_id && a.lap === b.lap) {
      setError('Pick two different laps.');
      return;
    }
    post<CompareAnswer>('/compare/laps', { laps: [a, b], step_m: 2 })
      .then((r) => { if (live) setCmp(r); })
      .catch((e) => { if (live) setError(String(e.message)); });
    return () => { live = false; };
  }, [a, b]);

  const loadRuns = useCallback(() => {
    const ids = [...new Set([a.session_id, b.session_id])];
    void Promise.all(ids.map((id) => get<RunLaps>(`/desktop/runs/${id}/laps`)))
      .then((got) => setRuns(Object.fromEntries(got.map((r) => [r.id, r]))));
  }, [a.session_id, b.session_id]);
  useEffect(loadRuns, [loadRuns]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'SELECT' || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      const i = codes.indexOf(corner.code);
      if (e.key === 'ArrowRight' && i < codes.length - 1) onCorner(codes[i + 1]);
      if (e.key === 'ArrowLeft' && i > 0) onCorner(codes[i - 1]);
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [codes, corner.code, onCorner, onBack]);

  const section = cmp?.sections.find((s) => s.code === corner.code) ?? null;
  const from = section ? Math.max(0, section.start_m - 80) : 0;
  const to = section ? section.end_m + 40 : 0;
  const lost = useMemo(() => {
    if (!section) return null;
    const [ta, tb] = section.times;
    return tb - ta;
  }, [section]);
  const words = cmp?.opportunities[1]?.sections.find((s) => s.code === corner.code) ?? null;
  const name = (ref: LapRef) => {
    const stint = stintName(session.runs, ref.session_id);
    return `Lap ${ref.lap}${stint ? ` · ${stint}` : ''}`;
  };
  // B against A from where the corner view starts: what B has lost (+) or found (−) in this corner so far
  const gapAt = (m: number) => {
    if (!cmp) return null;
    const d = cmp.traces.distance;
    const i = d.findIndex((x) => x >= m);
    return i < 0 ? null : cmp.traces.laps[1].t[i] - cmp.traces.laps[0].t[i];
  };
  const g0 = gapAt(from);
  const g1 = cursor != null && cursor >= from && cursor <= to ? gapAt(cursor) : null;
  const delta = g0 != null && g1 != null ? g1 - g0 : null;

  return (
    <div>
      <div className="row no-print" style={{ justifyContent: 'space-between' }}>
        <button className="btn small" onClick={onBack}>← All corners (Esc)</button>
        <div className="row">
          <button className="btn small" disabled={codes.indexOf(corner.code) <= 0}
            onClick={() => onCorner(codes[codes.indexOf(corner.code) - 1])}>← {codes[codes.indexOf(corner.code) - 1] ?? ''}</button>
          <button className="btn small" disabled={codes.indexOf(corner.code) >= codes.length - 1}
            onClick={() => onCorner(codes[codes.indexOf(corner.code) + 1])}>{codes[codes.indexOf(corner.code) + 1] ?? ''} →</button>
        </div>
      </div>
      <div className="board-head" style={{ marginTop: 12 }}>
        <div><div className="eyebrow">Corner</div><h1>{corner.code}</h1></div>
        {lost != null && <div className={`figure ${lost > 0 ? 'red' : ''}`}><span className="eyebrow">B loses here</span>
          <b className="num">{seconds(lost)}</b></div>}
        {delta != null && <div className="figure"><span className="eyebrow">B against A so far</span>
          <b className="num">{delta >= 0 ? '+' : '−'}{seconds(Math.abs(delta))}</b></div>}
      </div>

      <div className="row no-print" style={{ marginTop: 12 }}>
        <LapPicker label="A" value={a} runs={session.runs} onPick={setA} />
        <LapPicker label="B" value={b} runs={session.runs} onPick={setB} />
      </div>

      {error && <p className="error">{error}</p>}
      {!cmp && !error && <p className="muted">Putting the two laps on one line…</p>}
      {cmp && section && (
        <>
          <div style={{ marginTop: 14 }}>
            <VideoPair
              a={{ tag: 'A', title: name(a), run: runs[a.session_id] ?? null, lap: a.lap, t: cmp.traces.laps[0].t }}
              b={{ tag: 'B', title: name(b), run: runs[b.session_id] ?? null, lap: b.lap, t: cmp.traces.laps[1].t }}
              distance={cmp.traces.distance} startAt={from} onCursor={onCursor} seekTo={seek} onChanged={loadRuns} />
          </div>
          <div className="section">
            <div className="section-head"><h2>What to do</h2></div>
            {corner.holder.lap === a.lap && corner.holder.session_id === a.session_id
              && corner.versus.lap === b.lap && corner.versus.session_id === b.session_id ? (
                <p className="read">{corner.words} <b style={{ color: 'var(--loss)' }}>Worth {seconds(corner.gain)}.</b>
                  {corner.also && <><br /><span className="muted">{corner.also}</span></>}</p>
              ) : null}
            {words && words.differences.length > 0 && (
              <>
                <div className="eyebrow">Lap B against lap A here</div>
                <ul className="diffs">{words.differences.map((d) => <li key={d.metric}>{d.text}</li>)}</ul>
              </>
            )}
            {(!words || !words.differences.length) && !(corner.holder.lap === a.lap) &&
              <p className="note">No clear difference in technique between these two laps here.</p>}
          </div>
          <div className="section">
            <div className="section-head"><h2>Traces</h2>
              <span className="muted">{from}–{to} m · {name(a)} {lapTime(cmp.laps[0].time)} against {name(b)} {lapTime(cmp.laps[1].time)}</span></div>
            <Traces distance={cmp.traces.distance} a={cmp.traces.laps[0]} b={cmp.traces.laps[1]} from={from} to={to}
              cursor={cursor} onSeek={(m) => setSeek({ metres: m, n: Date.now() })} />
          </div>
        </>
      )}
    </div>
  );
}

function LapPicker({ label, value, runs, onPick }: { label: 'A' | 'B'; value: LapRef; runs: SessionRun[];
  onPick: (r: LapRef) => void }) {
  const id = `pick-${label}`;
  return (
    <label className="row" style={{ gap: 6 }} htmlFor={id}>
      <span className={`lap-tag ${label.toLowerCase()}`}>{label}</span>
      <select id={id} value={`${value.session_id}:${value.lap}`}
        onChange={(e) => { const [s, l] = e.target.value.split(':').map(Number); onPick({ session_id: s, lap: l }); }}>
        {runs.map((r) => (
          <optgroup key={r.id} label={stintName(runs, r.id) || 'Laps'}>
            {r.laps.filter(isClean).map((l) => (
              <option key={l.number} value={`${r.id}:${l.number}`}>Lap {l.number} · {lapTime(l.time)}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
