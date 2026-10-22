// Two onboards side by side, locked by distance (Gabriele, 2026-10-22, the redesign: "how the video locks to the
// data"): lap A's video leads, and lap B's is held at the same metre of the lap, so both cars reach the apex together
// and the gap shows as time. Each video is on its run's clock (server/app/videos.py: start = the log's time at the
// video's first frame), so a frame's time into the lap is video time + start - the lap's start, and the lap's trace
// ("t" against distance) turns that into metres.
import { useEffect, useRef, useState } from 'react';

import { bridge, post, put, videoSrc } from '../api';
import type { RunLaps, Video } from '../api';
import { interp } from '../board';

export type Side = {
  tag: 'A' | 'B';
  title: string;
  run: RunLaps | null;
  lap: number;
  t: number[]; // time into the lap at each distance
};

const FRAME = 1 / 30;

function lapOf(run: RunLaps | null, lap: number) {
  return run?.laps.find((l) => l.number === lap) ?? null;
}

/** The synced video that holds the whole lap, if one does. */
export function videoFor(run: RunLaps | null, lap: number): Video | null {
  const l = lapOf(run, lap);
  if (!run || !l) return null;
  return run.videos.find((v) => v.exists && v.start != null && v.start <= l.start + 0.5
    && (v.duration == null || v.start + v.duration >= l.start + l.time - 0.5)) ?? null;
}

export function VideoPair({ a, b, distance, startAt, onCursor, seekTo, onChanged }: {
  a: Side;
  b: Side;
  distance: number[];
  startAt: number; // metres: where the videos wait when the corner opens
  onCursor: (metres: number | null) => void;
  seekTo: { metres: number; n: number } | null; // a click on the chart
  onChanged: () => void; // a video was added or synced: the runs are asked again
}) {
  const refA = useRef<HTMLVideoElement>(null);
  const refB = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const va = videoFor(a.run, a.lap);
  const vb = videoFor(b.run, b.lap);
  const lapA = lapOf(a.run, a.lap);
  const lapB = lapOf(b.run, b.lap);

  // metres -> each video's time, and back from the leading one
  const videoTime = (side: Side, v: Video | null, metres: number) => {
    const l = lapOf(side.run, side.lap);
    if (!v || !l || v.start == null) return null;
    return l.start + interp(metres, distance, side.t) - v.start;
  };
  const leader = va ? { side: a, v: va, el: refA } : vb ? { side: b, v: vb, el: refB } : null;
  const metresNow = () => {
    if (!leader || !leader.el.current || leader.v.start == null) return null;
    const l = lapOf(leader.side.run, leader.side.lap);
    if (!l) return null;
    return interp(leader.el.current.currentTime + leader.v.start - l.start, leader.side.t, distance);
  };
  const place = (metres: number) => {
    for (const [side, v, el] of [[a, va, refA], [b, vb, refB]] as const) {
      const t = videoTime(side, v, metres);
      if (t != null && el.current) el.current.currentTime = Math.max(0, t);
    }
    onCursor(metres);
  };

  // open at the corner
  useEffect(() => {
    const go = () => place(startAt);
    const el = (va ? refA : refB).current;
    if (!el) return;
    if (el.readyState >= 1) go(); else el.addEventListener('loadedmetadata', go, { once: true });
    return () => el.removeEventListener('loadedmetadata', go);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [va?.id, vb?.id, a.lap, b.lap, startAt]);

  useEffect(() => { if (seekTo) place(seekTo.metres); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [seekTo?.n]);

  // while playing, the follower is held at the leader's metre
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const m = metresNow();
      if (m != null) {
        onCursor(m);
        const follower = leader?.el === refA ? { side: b, v: vb, el: refB } : { side: a, v: va, el: refA };
        const t = videoTime(follower.side, follower.v, m);
        const el = follower.el.current;
        if (t != null && el) {
          const drift = t - el.currentTime;
          if (Math.abs(drift) > 0.25) el.currentTime = t;
          else el.playbackRate = rate * (1 + Math.max(-0.2, Math.min(0.2, drift * 2)));
        }
        if (lapA && m >= distance[distance.length - 1] - 5) setPlaying(false);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, va?.id, vb?.id, rate]);

  useEffect(() => {
    for (const el of [refA.current, refB.current]) {
      if (!el) continue;
      el.playbackRate = rate;
      if (playing) void el.play().catch(() => undefined); else el.pause();
    }
  }, [playing, rate, va?.id, vb?.id]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const step = (s: number) => {
    setPlaying(false);
    const m = metresNow();
    if (m == null || !leader?.el.current) return;
    leader.el.current.currentTime = Math.max(0, leader.el.current.currentTime + s);
    const after = metresNow();
    if (after != null) place(after);
  };

  const any = va || vb;
  return (
    <div className="section" style={{ marginTop: 0, borderTop: 0, paddingTop: 0 }}>
      <div className="versus">
        <VideoSide side={a} v={va} el={refA} lap={lapA} onChanged={onChanged} />
        <VideoSide side={b} v={vb} el={refB} lap={lapB} onChanged={onChanged} />
      </div>
      {any && (
        <div className="row no-print">
          <button className="btn ink" onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Play'} (space)</button>
          <button className="btn small" onClick={() => step(-1)}>−1 s</button>
          <button className="btn small" onClick={() => step(-FRAME)}>− frame</button>
          <button className="btn small" onClick={() => step(FRAME)}>+ frame</button>
          <button className="btn small" onClick={() => step(1)}>+1 s</button>
          <button className="btn small" onClick={() => place(startAt)}>Back to the corner</button>
          <label className="row" style={{ gap: 6 }}>Speed
            <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
              <option value={1}>1×</option><option value={0.5}>½×</option><option value={0.25}>¼×</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

function VideoSide({ side, v, el, lap, onChanged }: {
  side: Side; v: Video | null; el: React.RefObject<HTMLVideoElement>;
  lap: { start: number; time: number } | null; onChanged: () => void;
}) {
  const unsynced = side.run?.videos.filter((x) => x.exists && x.start == null) ?? [];
  const tag = side.tag === 'A' ? 'a' : 'b';
  if (v) {
    return (
      <div className="video-box">
        <video ref={el} src={videoSrc(v.id)} muted preload="auto" playsInline />
        <span className="caption"><span className={`lap-tag ${tag}`}>{side.tag}</span> {side.title}</span>
        <NudgeButtons v={v} onChanged={onChanged} />
      </div>
    );
  }
  if (unsynced.length) return <SyncPanel side={side} v={unsynced[0]} onChanged={onChanged} />;
  return (
    <div className="video-box">
      <div className="empty">
        <span><span className={`lap-tag ${tag}`}>{side.tag}</span> {side.title}</span>
        <span>{side.run?.videos.length ? 'No video of this run holds this lap.' : 'No onboard for this run yet.'}</span>
        {lap && side.run && <AddVideo runId={side.run.id} onChanged={onChanged} />}
      </div>
    </div>
  );
}

function NudgeButtons({ v, onChanged }: { v: Video; onChanged: () => void }) {
  const nudge = async (s: number) => { await put(`/desktop/videos/${v.id}`, { start: (v.start ?? 0) + s }); onChanged(); };
  return (
    <span className="no-print" style={{ position: 'absolute', right: 8, top: 6, display: 'flex', gap: 4 }}>
      <span style={{ fontSize: 12, alignSelf: 'center', textShadow: '0 1px 2px #000' }}>
        {v.method === 'vbox' ? 'VBOX clock' : v.method === 'gps' ? 'GPS match' : 'Start line'}
      </span>
      <button className="btn small" style={{ background: '#0008', color: '#fff', borderColor: '#fff' }}
        title="The video is ahead of the data: hold it back one frame" onClick={() => void nudge(FRAME)}>◀ 1 fr</button>
      <button className="btn small" style={{ background: '#0008', color: '#fff', borderColor: '#fff' }}
        title="The video is behind the data: move it on one frame" onClick={() => void nudge(-FRAME)}>1 fr ▶</button>
    </span>
  );
}

export function AddVideo({ runId, onChanged }: { runId: number; onChanged: () => void }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async (path: string) => {
    setError(null);
    try {
      await post('/desktop/videos', { session_id: runId, path });
      onChanged();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  if (bridge?.pickVideo) {
    return (
      <>
        <button className="btn" onClick={async () => { const p = await bridge!.pickVideo!(); if (p) await add(p); }}>
          Add onboard video
        </button>
        {error && <span className="error">{error}</span>}
      </>
    );
  }
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); if (typed) void add(typed); }}>
      <input type="text" id={`video-${runId}`} placeholder="Path of the video file" value={typed}
        onChange={(e) => setTyped(e.target.value)} />
      <button className="btn" type="submit">Add video</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

/** A video the app couldn't put on the clock by itself: step to the frame where the car crosses the start/finish
 * line and say which lap starts there. */
function SyncPanel({ side, v, onChanged }: { side: Side; v: Video; onChanged: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const laps = side.run?.laps ?? [];
  const [lap, setLap] = useState(side.lap);
  const [error, setError] = useState<string | null>(null);
  const step = (s: number) => { if (ref.current) ref.current.currentTime = Math.max(0, ref.current.currentTime + s); };
  const save = async () => {
    setError(null);
    try {
      await put(`/desktop/videos/${v.id}/start-line`, { video_s: ref.current?.currentTime ?? 0, lap });
      onChanged();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  return (
    <div className="sync">
      <b>Put {v.name} on the data's clock</b>
      <span className="note">The app couldn't match this video by itself. Find the frame where the car crosses the
        start/finish line, then say which lap starts there.</span>
      <div className="video-box"><video ref={ref} src={videoSrc(v.id)} muted controls preload="auto" /></div>
      <div className="row">
        <button className="btn small" onClick={() => step(-1)}>−1 s</button>
        <button className="btn small" onClick={() => step(-FRAME)}>− frame</button>
        <button className="btn small" onClick={() => step(FRAME)}>+ frame</button>
        <button className="btn small" onClick={() => step(1)}>+1 s</button>
      </div>
      <div className="row">
        <label className="row" style={{ gap: 6 }}>Lap starting here
          <select value={lap} onChange={(e) => setLap(Number(e.target.value))}>
            {laps.map((l) => <option key={l.number} value={l.number}>{l.number}</option>)}
          </select>
        </label>
        <button className="btn red" onClick={() => void save()}>Car crosses the line here</button>
      </div>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
