// Charts for the grip report: a scatter with a trend line, the g-g diagram with the car's grip limit, grip use by
// phase for the quickest and slowest laps, and the track coloured by grip use or traction control.
// Each chart reads out the point nearest the finger (or the mouse on the web) in a line above it.
import { ComponentProps, ReactNode, useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Platform, Pressable, StyleSheet } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { Text, View } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { byScheme, Fonts, inkOn, Radius, ramp, themed } from '@/constants/Theme';

// Slots 1 and 2 of the validated chart palette, a grey for context, ink, and two one-hue ramps (grip in blue,
// traction control in orange), each stepped for its own mode; status colours for the verdicts.
const PALETTE = byScheme((c) => ({
  ink: c.chart.ink, ink2: c.chart.ink2, muted: c.chart.muted, grid: c.chart.grid, surface: c.chart.surface,
  s1: c.chart.series[0], s2: c.chart.series[1], other: c.chart.other, wash: c.chart.wash, track: c.chart.track,
  seq: c.chart.seq, tc: c.chart.seq2,
  critical: c.status.critical, warning: c.status.warning, good: c.status.good,
}));
export type ChartColors = (typeof PALETTE)['light'];
export const useChartColors = (): ChartColors => PALETTE[useColorScheme() === 'dark' ? 'dark' : 'light'];

// the ramp step and the text colour on a cell, from the theme (here for the report screens that import them from here)
export { inkOn, ramp };

// SVG text falls back to a serif face on the web; use the page's sans-serif instead.
const FONT = Fonts.sans;
function T(props: ComponentProps<typeof SvgText>) {
  return <SvgText fontFamily={FONT} {...props} />;
}

/** A number with a true minus sign. */
export const num = (v: number, digits = 0) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(digits);

function ticks(lo: number, hi: number, n: number) {
  const span = hi - lo || 1;
  const mag = 10 ** Math.floor(Math.log10(span / n));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => span / k <= n) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  // as many decimals as the step needs: 2.5 -> 1, 0.2 -> 1, 5 -> 0
  let digits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  while (digits < 4 && Math.abs(step * 10 ** digits - Math.round(step * 10 ** digits)) > 1e-6) digits++;
  return { values: out, label: (v: number) => num(v, digits) };
}

/** Width of the parent, and pointer position (finger or mouse) inside it. */
function usePointer() {
  const [width, setWidth] = useState(0);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const grab = (e: GestureResponderEvent) => setAt({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
  const props = {
    onLayout: (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width),
    onStartShouldSetResponder: () => true,
    onResponderGrant: grab,
    onResponderMove: grab,
    ...(Platform.OS === 'web'
      ? {
          onMouseMove: (e: any) =>
            setAt({ x: e.nativeEvent.offsetX ?? e.nativeEvent.locationX, y: e.nativeEvent.offsetY ?? e.nativeEvent.locationY }),
          onMouseLeave: () => setAt(null),
        }
      : {}),
  };
  return { width, at, props };
}

function nearest<T>(items: T[], pos: (t: T, i: number) => [number, number], at: { x: number; y: number } | null, reach = 30) {
  if (!at) return -1;
  let best = -1;
  let bd = reach * reach;
  items.forEach((it, i) => {
    const [x, y] = pos(it, i);
    const d = (x - at.x) ** 2 + (y - at.y) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

export function Readout({ children, hint }: { children: ReactNode; hint: string }) {
  const styles = useStyles();
  return (
    <Text style={[styles.readout, !children && styles.hint]} numberOfLines={2}>
      {children || hint}
    </Text>
  );
}

export function LegendItem({ color, label, kind = 'dot' }: { color: string; label: string; kind?: 'dot' | 'ring' | 'line' | 'dash' }) {
  const styles = useStyles();
  return (
    <View style={styles.legendItem}>
      {kind === 'dot' ? (
        <View style={[styles.legendDot, { backgroundColor: color }]} />
      ) : kind === 'ring' ? (
        <Svg width={10} height={10}>
          <Circle cx={5} cy={5} r={3.6} fill="none" stroke={color} strokeWidth={1.5} />
        </Svg>
      ) : (
        <Svg width={18} height={8}>
          <Line x1={1} x2={17} y1={4} y2={4} stroke={color} strokeWidth={2} strokeDasharray={kind === 'dash' ? '4 3' : undefined} />
        </Svg>
      )}
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

// ---------- scatter with a trend line ----------

export type ScatterPoint = { x: number; y: number; color: string; front?: boolean; label: string };

export function Scatter({ points, xLabel, yLabel, fit, yFmt, height = 240, hint }: {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  fit?: { slope: number; intercept: number } | null;
  yFmt?: (v: number) => string; // tick labels on the y axis; numbers sized to the step if left out
  height?: number;
  hint: string;
}) {
  const styles = useStyles();
  const c = useChartColors();
  const { width, at, props } = usePointer();
  const pad = { l: 40, r: 10, t: 22, b: 34 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0r, x1r] = [Math.min(...xs), Math.max(...xs)];
  const [y0r, y1r] = [Math.min(...ys), Math.max(...ys)];
  const xm = (x1r - x0r) * 0.06 || 1;
  const ym = (y1r - y0r) * 0.08 || 1;
  const [x0, x1, y0, y1] = [x0r - xm, x1r + xm, y0r - ym, y1r + ym];
  const w = Math.max(width - pad.l - pad.r, 1);
  const h = height - pad.t - pad.b;
  const X = (v: number) => pad.l + ((v - x0) / (x1 - x0)) * w;
  const Y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * h;
  const order = points.map((_, i) => i).sort((a, b) => Number(!!points[a].front) - Number(!!points[b].front));
  const hit = nearest(points, (p) => [X(p.x), Y(p.y)], at);
  const yt = ticks(y0, y1, 4);
  const xt = ticks(x0, x1, width < 420 ? 4 : 6);
  return (
    <View style={styles.chart}>
      <Readout hint={hint}>{hit >= 0 ? points[hit].label : null}</Readout>
      <View {...props}>
        {width > 0 && points.length > 0 && (
          <Svg width={width} height={height} pointerEvents="none">
            {yt.values.map((v) => (
              <G key={`y${v}`}>
                <Line x1={pad.l} x2={width - pad.r} y1={Y(v)} y2={Y(v)} stroke={c.grid} strokeWidth={1} />
                <T x={pad.l - 6} y={Y(v) + 4} fontSize={10} fill={c.muted} textAnchor="end">
                  {yFmt ? yFmt(v) : yt.label(v)}
                </T>
              </G>
            ))}
            {xt.values.map((v) => (
              <T key={`x${v}`} x={X(v)} y={height - pad.b + 14} fontSize={10} fill={c.muted} textAnchor="middle">
                {xt.label(v)}
              </T>
            ))}
            <T x={pad.l + w / 2} y={height - 4} fontSize={11} fill={c.ink2} textAnchor="middle">
              {xLabel}
            </T>
            <T x={0} y={11} fontSize={11} fill={c.ink2}>
              {yLabel}
            </T>
            {fit && (
              <Line x1={X(x0)} x2={X(x1)} y1={Y(fit.intercept + fit.slope * x0)} y2={Y(fit.intercept + fit.slope * x1)}
                stroke={c.ink2} strokeOpacity={0.7} strokeWidth={2} strokeDasharray="5 4" />
            )}
            {order.map((i) => (
              <Circle key={i} cx={X(points[i].x)} cy={Y(points[i].y)} r={4.5} fill={points[i].color} stroke={c.surface}
                strokeWidth={1.5} />
            ))}
            {hit >= 0 && (
              <Circle cx={X(points[hit].x)} cy={Y(points[hit].y)} r={7} fill="none" stroke={c.ink} strokeWidth={1.5} />
            )}
          </Svg>
        )}
      </View>
    </View>
  );
}

// ---------- g-g diagram ----------

export type GgSeries = {
  name: string; color: string; ax: number[]; ay: number[]; speed: number[]; label: (i: number) => string;
  shaped?: boolean[]; // drawn as rings: on a banked corner, a crest or a compression
};

export function GgDiagram({ limit, series, band, hint }: {
  limit: { directions: number[]; radius: number[] };
  series: GgSeries[];
  band: [number, number | null];
  hint: string;
}) {
  const styles = useStyles();
  const c = useChartColors();
  const { width, at, props } = usePointer();
  const height = Math.min(Math.max(width * 0.8, 240), 420);
  const pad = { l: 34, r: 8, t: 8, b: 30 };
  const xr: [number, number] = [-2, 2];
  const yr: [number, number] = [-2, 1.2];
  const sc = Math.min((width - pad.l - pad.r) / (xr[1] - xr[0]), (height - pad.t - pad.b) / (yr[1] - yr[0]));
  const ox = pad.l + (width - pad.l - pad.r - sc * (xr[1] - xr[0])) / 2;
  const X = (v: number) => ox + (v - xr[0]) * sc;
  const Y = (v: number) => pad.t + (yr[1] - v) * sc;
  const right = limit.directions.map((d, j) => [limit.radius[j] * Math.cos((d * Math.PI) / 180), limit.radius[j] * Math.sin((d * Math.PI) / 180)]);
  const ring = [...right, ...[...right].reverse().map(([x, y]) => [-x, y])];
  const ringPath = ring.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join('') + 'Z';
  const inBand = (v: number) => v >= band[0] && (band[1] == null || v < band[1]);
  const pts = series.flatMap((s, k) =>
    s.ax.flatMap((ax, i) => (inBand(s.speed[i]) ? [{ k, i, x: s.ay[i], y: ax }] : [])));
  const hit = nearest(pts, (p) => [X(p.x), Y(p.y)], at, 20);
  return (
    <View style={styles.chart}>
      <Readout hint={hint}>{hit >= 0 ? series[pts[hit].k].label(pts[hit].i) : null}</Readout>
      <View {...props}>
        {width > 0 && (
          <Svg width={width} height={height} pointerEvents="none">
            {[-2, -1, 0, 1, 2].map((v) => (
              <G key={`x${v}`}>
                <Line x1={X(v)} x2={X(v)} y1={Y(yr[0])} y2={Y(yr[1])} stroke={c.grid} strokeWidth={1} />
                <T x={X(v)} y={Y(yr[0]) + 13} fontSize={10} fill={c.muted} textAnchor="middle">
                  {num(v)}
                </T>
              </G>
            ))}
            {[-2, -1, 0, 1].map((v) => (
              <G key={`y${v}`}>
                <Line x1={X(xr[0])} x2={X(xr[1])} y1={Y(v)} y2={Y(v)} stroke={c.grid} strokeWidth={1} />
                <T x={X(xr[0]) - 5} y={Y(v) + 4} fontSize={10} fill={c.muted} textAnchor="end">
                  {num(v)}
                </T>
              </G>
            ))}
            <T x={X(0)} y={height - 3} fontSize={11} fill={c.ink2} textAnchor="middle">
              Lateral g
            </T>
            <T x={X(xr[1])} y={Y(yr[1]) + 11} fontSize={11} fill={c.ink2} textAnchor="end">
              Accelerating
            </T>
            <T x={X(xr[1])} y={Y(yr[0]) - 5} fontSize={11} fill={c.ink2} textAnchor="end">
              Braking
            </T>
            <Path d={ringPath} fill={c.wash} stroke={c.ink2} strokeWidth={2} strokeDasharray="6 4" />
            {pts.map((p) => (series[p.k].shaped?.[p.i] ? (
              <Circle key={`${p.k}-${p.i}`} cx={X(p.x)} cy={Y(p.y)} r={3.4} fill="none" stroke={series[p.k].color}
                strokeWidth={1.5} />
            ) : (
              <Circle key={`${p.k}-${p.i}`} cx={X(p.x)} cy={Y(p.y)} r={2.6} fill={series[p.k].color} fillOpacity={0.8} />
            )))}
            {hit >= 0 && <Circle cx={X(pts[hit].x)} cy={Y(pts[hit].y)} r={6} fill="none" stroke={c.ink} strokeWidth={1.5} />}
          </Svg>
        )}
      </View>
    </View>
  );
}

// ---------- quickest against slowest third, by phase ----------

export function Dumbbell({ rows, hint }: {
  rows: { label: string; sub: string; fast: number | null; slow: number | null }[];
  hint: string;
}) {
  const styles = useStyles();
  const c = useChartColors();
  const { width, at, props } = usePointer();
  const rowH = 44;
  const left = 104;
  const height = rows.length * rowH + 22;
  const vals = rows.flatMap((r) => [r.fast, r.slow]).filter((v): v is number => v != null);
  const lo = Math.floor((Math.min(...vals) - 2) / 5) * 5;
  const hi = Math.ceil((Math.max(...vals) + 2) / 5) * 5;
  const X = (v: number) => left + ((v - lo) / (hi - lo || 1)) * Math.max(width - left - 40, 1);
  const hitRow = at ? Math.floor((at.y - 4) / rowH) : -1;
  const r = rows[hitRow];
  return (
    <View style={styles.chart}>
      <Readout hint={hint}>
        {r && r.fast != null && r.slow != null
          ? `${r.label}: quickest third ${r.fast.toFixed(1)} %, slowest third ${r.slow.toFixed(1)} % (${r.sub})`
          : null}
      </Readout>
      <View {...props}>
        {width > 0 && vals.length > 0 && (
          <Svg width={width} height={height} pointerEvents="none">
            {ticks(lo, hi, 4).values.map((v) => (
              <G key={v}>
                <Line x1={X(v)} x2={X(v)} y1={4} y2={height - 20} stroke={c.grid} strokeWidth={1} />
                <T x={X(v)} y={height - 6} fontSize={10} fill={c.muted} textAnchor="middle">
                  {`${v} %`}
                </T>
              </G>
            ))}
            {rows.map((row, j) => {
              const y = 18 + j * rowH;
              return (
                <G key={row.label}>
                  <T x={0} y={y + 4} fontSize={12} fill={c.ink}>
                    {row.label}
                  </T>
                  <T x={0} y={y + 19} fontSize={10} fill={c.muted}>
                    {row.sub}
                  </T>
                  {row.fast != null && row.slow != null && (
                    <>
                      <Line x1={X(Math.min(row.fast, row.slow))} x2={X(Math.max(row.fast, row.slow))} y1={y} y2={y}
                        stroke={c.ink2} strokeWidth={2} />
                      <Circle cx={X(row.slow)} cy={y} r={6} fill={c.other} stroke={c.surface} strokeWidth={2} />
                      <Circle cx={X(row.fast)} cy={y} r={6} fill={c.s1} stroke={c.surface} strokeWidth={2} />
                      <T x={X(Math.max(row.fast, row.slow)) + 10} y={y + 4} fontSize={11} fill={c.ink2}>
                        {`${row.fast - row.slow >= 0 ? '+' : '−'}${Math.abs(row.fast - row.slow).toFixed(1)}`}
                      </T>
                    </>
                  )}
                </G>
              );
            })}
          </Svg>
        )}
      </View>
    </View>
  );
}

// ---------- the track, coloured by grip use or traction control ----------

export type MapMode = { key: string; label: string; values: (number | null)[]; ramp: string[]; lo: number; hi: number; unit: string; skipBelow?: number };

export function GripMap({ x, y, step, modes, labels, describe }: {
  x: number[];
  y: number[];
  step: number;
  modes: MapMode[];
  labels: { code: string; at: number }[];
  describe: (metre: number) => string;
}) {
  const styles = useStyles();
  const c = useChartColors();
  const [mode, setMode] = useState(0);
  const { width, at, props } = usePointer();
  const md = modes[mode];
  const pad = 26;
  const [x0, x1, y0, y1] = [Math.min(...x), Math.max(...x), Math.min(...y), Math.max(...y)];
  const sc = Math.min((width - 2 * pad) / (x1 - x0 || 1), 300 / (y1 - y0 || 1));
  const height = (y1 - y0) * sc + 2 * pad;
  const X = (v: number) => pad + (v - x0) * sc + (width - 2 * pad - (x1 - x0) * sc) / 2;
  const Y = (v: number) => pad + (y1 - v) * sc;
  const base = x.map((v, i) => `${i ? 'L' : 'M'}${X(v).toFixed(1)},${Y(y[i]).toFixed(1)}`).join('') + 'Z';
  // one path per colour step keeps the drawing light
  const STEPS = 8;
  const paths: string[] = Array(STEPS).fill('');
  for (let i = 0; i < x.length - 1; i++) {
    const v = md.values[i];
    if (v == null || (md.skipBelow != null && v < md.skipBelow)) continue;
    const k = Math.min(STEPS - 1, Math.max(0, Math.floor(((v - md.lo) / (md.hi - md.lo)) * STEPS)));
    paths[k] += `M${X(x[i]).toFixed(1)},${Y(y[i]).toFixed(1)}L${X(x[i + 1]).toFixed(1)},${Y(y[i + 1]).toFixed(1)}`;
  }
  const cx = x.reduce((a, b) => a + b, 0) / x.length;
  const cy = y.reduce((a, b) => a + b, 0) / y.length;
  const place = (i: number) => {
    const j = Math.max(0, Math.min(x.length - 1, i));
    const a = Math.min(j + 3, x.length - 1);
    const b = Math.max(j - 3, 0);
    let px = -(y[a] - y[b]);
    let py = x[a] - x[b];
    const n = Math.hypot(px, py) || 1;
    px /= n;
    py /= n;
    if (px * (x[j] - cx) + py * (y[j] - cy) < 0) {
      px = -px;
      py = -py;
    }
    return [Math.max(14, Math.min(width - 14, X(x[j]) + px * 16)), Y(y[j]) - py * 16 + 4];
  };
  const hit = nearest(x, (_, i): [number, number] => [X(x[i]), Y(y[i])], at, 24);
  return (
    <View style={styles.chart}>
      <View style={styles.tabs}>
        {modes.map((m, i) => (
          <Pressable key={m.key} onPress={() => setMode(i)} style={i === mode ? [styles.tab, { borderColor: c.ink }] : styles.tab}>
            <Text style={i === mode ? styles.tabOn : styles.tabText}>{m.label}</Text>
          </Pressable>
        ))}
      </View>
      <Readout hint="Point at the track to read it.">
        {hit >= 0 ? `${describe(hit * step)} · ${md.values[hit] == null ? 'full throttle, the engine is the limit' : `${md.label.toLowerCase()} ${Math.round(md.values[hit] as number)} ${md.unit}`}` : null}
      </Readout>
      <View {...props}>
        {width > 0 && (
          <Svg width={width} height={height} pointerEvents="none">
            <Path d={base} fill="none" stroke={c.track} strokeWidth={10} strokeLinejoin="round" />
            {paths.map((d, k) => (d ? <Path key={k} d={d} stroke={ramp(md.ramp, (k + 0.5) / STEPS)} strokeWidth={6} strokeLinecap="round" /> : null))}
            {labels.map((l) => {
              const [lx, ly] = place(Math.round(l.at / step));
              return (
                <T key={l.code} x={lx} y={ly} fontSize={11} fontWeight="700" fill={c.ink} textAnchor="middle">
                  {l.code}
                </T>
              );
            })}
            <Rect x={X(x[0]) - 4} y={Y(y[0]) - 4} width={8} height={8} fill={c.ink} transform={`rotate(45 ${X(x[0])} ${Y(y[0])})`} />
            {hit >= 0 && <Circle cx={X(x[hit])} cy={Y(y[hit])} r={7} fill="none" stroke={c.ink} strokeWidth={2} />}
          </Svg>
        )}
      </View>
      <View style={styles.legendRow}>
        <Text style={styles.legendText}>{`${md.lo} ${md.unit}`}</Text>
        <Svg width={90} height={8}>
          {Array.from({ length: STEPS }, (_, k) => (
            <Rect key={k} x={(k * 90) / STEPS} y={0} width={90 / STEPS} height={8} fill={ramp(md.ramp, (k + 0.5) / STEPS)} />
          ))}
        </Svg>
        <Text style={styles.legendText}>{`${md.hi} ${md.unit}`}</Text>
        <LegendItem color={c.track} label={md.key === 'grip' ? 'Full throttle' : 'No TC'} kind="line" />
        <Text style={styles.legendText}>◆ Start / finish</Text>
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  chart: { gap: 4 },
  readout: { fontSize: 12, lineHeight: 16, minHeight: 32, fontVariant: ['tabular-nums'] },
  hint: { opacity: 0.55 },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 9, height: 9, borderRadius: 5 },
  legendText: { fontSize: 12, opacity: 0.75 },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tab: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.chip, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: c.surface },
  tabText: { fontSize: 13, opacity: 0.7 },
  tabOn: { fontSize: 13, fontWeight: '600' },
}));
