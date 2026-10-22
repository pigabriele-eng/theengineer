// The track map, always on the right (Gabriele, 2026-10-16: "Track map must be visible at all times"): the event's
// fastest lap drawn with the official corner numbers. The corner being looked at is drawn red; a tap on a number
// opens that corner. Where the video cursor is, a dot moves round the lap.
import { useMemo } from 'react';

import type { TrackMapAnswer } from '../api';

const PAD = 34;

export function TrackMap({ map, active, onCorner, at }: {
  map: TrackMapAnswer | null;
  active?: string | null; // a section code ("T2-T5") or a corner ("T6")
  onCorner?: (code: string) => void;
  at?: number | null; // metres into the lap of the cursor
}) {
  const drawn = useMemo(() => {
    if (!map || map.x.length < 2) return null;
    const xs = map.x, ys = map.y;
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX || 1, h = maxY - minY || 1;
    const size = 600;
    const k = (size - 2 * PAD) / Math.max(w, h);
    const W = w * k + 2 * PAD, H = h * k + 2 * PAD;
    const px = (x: number) => PAD + (x - minX) * k;
    const py = (y: number) => H - PAD - (y - minY) * k; // north up
    const pts = xs.map((x, i) => `${px(x).toFixed(1)},${py(ys[i]).toFixed(1)}`);
    const at = (m: number) => Math.max(0, Math.min(xs.length - 1, Math.round(m / map.step_m)));
    return { W, H, px, py, line: pts.join(' '), pts, at };
  }, [map]);

  if (!map) return <div className="map muted">The map appears once a lap with GPS is in.</div>;
  if (!drawn) return null;
  const section = active ? map.sections.find((s) => s.code === active || s.corners.includes(active)) : null;
  const hot = section ? drawn.pts.slice(drawn.at(section.start_m), drawn.at(section.end_m) + 1).join(' ') : null;
  const cursor = at != null ? drawn.at(at) : null;
  const s = map.start;
  return (
    <div className="map">
      <svg viewBox={`0 0 ${drawn.W.toFixed(0)} ${drawn.H.toFixed(0)}`} role="img"
        aria-label={`Track map with the official corner numbers${section ? `, ${section.code} picked` : ''}`}>
        <polyline points={drawn.line} fill="none" stroke="var(--track)" strokeWidth={9} strokeLinejoin="round"
          strokeLinecap="round" />
        {hot && <polyline points={hot} fill="none" stroke="var(--mark)" strokeWidth={9} strokeLinecap="round"
          strokeLinejoin="round" />}
        <line x1={drawn.px(s.x) - s.dy * 14} y1={drawn.py(s.y) - s.dx * 14} x2={drawn.px(s.x) + s.dy * 14}
          y2={drawn.py(s.y) + s.dx * 14} stroke="var(--ink)" strokeWidth={4} />
        {cursor != null && <circle cx={drawn.pts[cursor].split(',')[0]} cy={drawn.pts[cursor].split(',')[1]} r={9}
          fill="var(--a)" stroke="var(--paper)" strokeWidth={3} />}
        {map.corners.map((c) => {
          const on = !!section && section.corners.includes(c.code);
          return (
            <text key={c.code} x={drawn.px(c.x) + 10} y={drawn.py(c.y) - 8} className={on ? 'on' : undefined}
              role="button" tabIndex={0} aria-label={`Open ${c.code}`}
              onClick={() => onCorner?.(c.code)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onCorner?.(c.code); }}>{c.code}</text>
          );
        })}
      </svg>
      <div className="muted no-print" style={{ fontSize: 13 }}>
        {map.numbering === 'official' ? 'Official corner numbers' : 'Corner numbers found from the laps'} · tap a number
      </div>
    </div>
  );
}
