// Two laps through one corner: speed, brake, throttle and steering against the distance into the lap, A in blue and
// B in red, each line also named (A, B) so it reads without colour. The cursor is where the videos are; a click on
// the chart moves the videos there.
import { useRef } from 'react';

import type { Trace } from '../api';

const ROLES: { key: keyof Trace; label: string; h: number }[] = [
  { key: 'speed', label: 'Speed km/h', h: 130 },
  { key: 'brake', label: 'Brake', h: 60 },
  { key: 'throttle', label: 'Throttle %', h: 60 },
  { key: 'steer', label: 'Steering', h: 60 },
];
const W = 900;
const LEFT = 70;
const GAP = 14;

export function Traces({ distance, a, b, from, to, cursor, onSeek }: {
  distance: number[];
  a: Trace;
  b: Trace;
  from: number; // metres
  to: number;
  cursor: number | null;
  onSeek: (metres: number) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const i0 = Math.max(0, distance.findIndex((d) => d >= from));
  let i1 = distance.findIndex((d) => d > to);
  if (i1 < 0) i1 = distance.length;
  const idx = distance.slice(i0, i1).map((_, k) => i0 + k);
  const roles = ROLES.filter((r) => Array.isArray(a[r.key]) && Array.isArray(b[r.key]));
  const total = roles.reduce((s, r) => s + r.h + GAP, 0) + 22;
  const x = (d: number) => LEFT + ((d - from) / (to - from || 1)) * (W - LEFT - 10);
  let top = 0;
  const panels = roles.map((r) => {
    const va = a[r.key] as number[], vb = b[r.key] as number[];
    const vals = idx.flatMap((i) => [va[i], vb[i]]).filter((v) => Number.isFinite(v));
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const y0 = top;
    const y = (v: number) => y0 + r.h - ((v - lo) / (hi - lo || 1)) * (r.h - 6) - 3;
    const path = (v: number[]) => idx.map((i, k) => `${k ? 'L' : 'M'}${x(distance[i]).toFixed(1)},${y(v[i]).toFixed(1)}`).join('');
    top += r.h + GAP;
    return (
      <g key={r.key}>
        <rect x={LEFT} y={y0} width={W - LEFT - 10} height={r.h} fill="var(--band)" />
        <text x={0} y={y0 + 14}>{r.label}</text>
        <text x={0} y={y0 + r.h - 2} className="num">{r.key === 'speed' ? `${Math.round(lo)}–${Math.round(hi)}` : ''}</text>
        <path d={path(va)} fill="none" stroke="var(--a)" strokeWidth={2} />
        <path d={path(vb)} fill="none" stroke="var(--b)" strokeWidth={2} strokeDasharray="6 3" />
      </g>
    );
  });
  const ticks = [];
  const step = (to - from) > 400 ? 100 : 50;
  for (let d = Math.ceil(from / step) * step; d <= to; d += step) ticks.push(d);

  const seek = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    if (px < LEFT) return;
    onSeek(from + ((px - LEFT) / (W - LEFT - 10)) * (to - from));
  };

  return (
    <div>
      <svg ref={ref} className="chart" viewBox={`0 0 ${W} ${total}`} onClick={seek} style={{ cursor: 'crosshair' }}
        role="img" aria-label="Speed, brake, throttle and steering of lap A and lap B through the corner">
        {panels}
        {ticks.map((d) => <text key={d} x={x(d)} y={total - 4} textAnchor="middle" className="num">{d} m</text>)}
        {cursor != null && cursor >= from && cursor <= to &&
          <line x1={x(cursor)} x2={x(cursor)} y1={0} y2={total - 18} stroke="var(--ink)" strokeWidth={1.5} />}
      </svg>
      <div className="legend">
        <span><span className="lap-tag a">A</span> solid line</span>
        <span><span className="lap-tag b">B</span> dashed line</span>
        <span className="muted">Click the chart to move both videos there</span>
      </div>
    </div>
  );
}
