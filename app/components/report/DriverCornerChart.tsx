// One corner, two drivers (the report's Drivers section): the speed, the brake and the throttle through it on one
// distance axis, metres from the apex, each driver's line the point by point median of the passes picked (Top 10%,
// Median, Bottom 10%). Each driver has a colour and a line style (the second dashed), a name at the end of their
// speed line, and marks of a shape of their own where they brake, where they are slowest and where they pick up the
// throttle: never colour alone. Touch or hover to read both at a point; pinch, scroll or drag a box to zoom, the three
// panels together (components/Zoom.tsx), as the report's other corner graphs (components/CornerTrace.tsx).
import { useId, useMemo, useState } from 'react';
import { LayoutChangeEvent } from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { Text, View } from '@/components/Themed';
import { ResetZoom, useZoom, ZoomArea } from '@/components/Zoom';
import { CornerGroup, DriverCorner, fromApex, Side, SIDES } from '@/lib/reportDrivers';
import { isZoomed, pixelOf, Range, shownRange, valueAt } from '@/lib/zoom';
import { face, Fonts, themed, useTheme } from '@/constants/Theme';

const PAD = { left: 40, right: 40, top: 22 }; // right: the drivers' names at the end of their lines
const GAP = 30; // between the panels: their titles sit in it
const AXIS = 22; // under the last panel: the distance ticks
export const DASH = '7 5'; // the second driver's line
const LEAST_POINTS = 6; // the narrowest zoom, in grid steps
const NAME_ROW = 15; // the least room between the two names at the end of the speed lines
const MARK = 4; // half a mark's size: 8 px across

type Key = 'speed' | 'brake' | 'throttle';
type Panel = { key: Key; title: string; unit: string; height: number; domain: [number, number]; digits: number };

const finite = (v: (number | null)[]) => v.filter((x): x is number => x != null && Number.isFinite(x));

function pathOf(values: (number | null)[], i0: number, i1: number, x: (i: number) => number, y: (v: number) => number) {
  let d = '';
  let pen = false;
  for (let i = i0; i <= Math.min(i1, values.length - 1); i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** The last point of a line in the part shown, for the driver's name at its end. */
function lastPoint(values: (number | null)[], i0: number, i1: number): number | null {
  for (let i = Math.min(i1, values.length - 1); i >= i0; i--) if (values[i] != null) return i;
  return null;
}

export default function DriverCornerChart({ corner, group, codes, colors, brakeUnit, wide }: {
  corner: DriverCorner;
  group: Record<Side, CornerGroup>;
  codes: Record<Side, string>;
  colors: Record<Side, string>;
  brakeUnit: string | null;
  wide: boolean;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const c = theme.chart;
  const zoom = useZoom();
  const clip = `clip${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const step = corner.step_m;
  const x0 = corner.from_m;
  const n = Math.max(group.a.speed.length, group.b.speed.length);
  const full: Range = [x0, x0 + Math.max(n - 1, 1) * step];
  const least = LEAST_POINTS * step;
  const view = shownRange(zoom.view, full, least);
  const zoomed = isZoomed(view, full);
  const i0 = Math.max(0, Math.floor((view[0] - x0) / step) - 1);
  const i1 = Math.min(n - 1, Math.ceil((view[1] - x0) / step) + 1);

  const panels = useMemo<Panel[]>(() => {
    const sp = SIDES.flatMap((s) => finite(group[s].speed.slice(i0, i1 + 1)));
    const round = zoomed ? 5 : 10;
    let lo = sp.length ? Math.floor(Math.min(...sp) / round) * round : 0;
    let hi = sp.length ? Math.ceil(Math.max(...sp) / round) * round : round;
    if (!(hi > lo)) [lo, hi] = [lo - round, hi + round];
    const out: Panel[] = [{ key: 'speed', title: 'Speed', unit: 'km/h', height: wide ? 150 : 130, domain: [lo, hi],
      digits: 0 }];
    const br = SIDES.flatMap((s) => finite(group[s].brake));
    if (br.length) {
      const top = Math.max(...br.map(Math.abs));
      out.push({ key: 'brake', title: 'Brake', unit: brakeUnit ?? '', height: wide ? 64 : 56,
        domain: [0, top > 0 ? Math.ceil(top / 10) * 10 : 1], digits: 0 });
    }
    if (SIDES.some((s) => finite(group[s].throttle).length)) {
      out.push({ key: 'throttle', title: 'Throttle', unit: '%', height: wide ? 64 : 56, domain: [0, 100], digits: 0 });
    }
    return out;
  }, [group, brakeUnit, wide, i0, i1, zoomed]);

  const w = Math.max(width - PAD.left - PAD.right, 1);
  const x = (i: number) => pixelOf(x0 + i * step, view, PAD.left, w);
  const mx = (m: number) => pixelOf(m, view, PAD.left, w);
  const tops: number[] = [];
  let y0 = PAD.top;
  for (const p of panels) {
    tops.push(y0);
    y0 += p.height + GAP;
  }
  const bottom = y0 - GAP;
  const height = bottom + AXIS;
  const yOf = (k: number) => (v: number) => {
    const p = panels[k];
    return tops[k] + (1 - (v - p.domain[0]) / (p.domain[1] - p.domain[0] || 1)) * p.height;
  };
  const indexAt = (m: number | null) => (m == null ? null : Math.round((m - x0) / step));
  const valueOf = (s: Side, key: Key, i: number | null) => (i == null || i < 0 ? null : group[s][key][i] ?? null);

  // each driver's marks: where they brake (brake), where they are slowest (speed), where the throttle comes on
  const marks = SIDES.flatMap((s) => ([
    ['brake', group[s].brake_point], ['speed', group[s].min_speed_at], ['throttle', group[s].throttle_on],
  ] as [Key, number | null][]).flatMap(([key, at]) => {
    const k = panels.findIndex((p) => p.key === key);
    const i = indexAt(at);
    const v = valueOf(s, key, i);
    if (k < 0 || at == null || v == null || at < view[0] || at > view[1]) return [];
    return [{ side: s, key, cx: mx(at), cy: yOf(k)(Math.min(Math.max(v, panels[k].domain[0]), panels[k].domain[1])) }];
  }));

  // the drivers' names at the end of their speed lines, kept apart
  const ends = SIDES.map((s) => {
    const i = lastPoint(group[s].speed, i0, i1);
    return { side: s, y: i == null ? null : yOf(0)(group[s].speed[i]!) };
  }).filter((e): e is { side: Side; y: number } => e.y != null).sort((p, q) => p.y - q.y);
  if (ends.length === 2 && ends[1].y - ends[0].y < NAME_ROW) {
    const mid = (ends[0].y + ends[1].y) / 2;
    ends[0].y = mid - NAME_ROW / 2;
    ends[1].y = mid + NAME_ROW / 2;
  }

  // ticks every 50 m (every 25 m zoomed in close), the apex named
  const span = view[1] - view[0];
  const every = span > 400 ? 100 : span > 120 ? 50 : 25;
  const ticks: number[] = [];
  for (let t = Math.ceil(view[0] / every) * every; t <= view[1]; t += every) ticks.push(t);

  const cursorAt = (px: number) =>
    setCursor(Math.max(0, Math.min(n - 1, Math.round((valueAt(px, view, PAD.left, w) - x0) / step))));
  const cx = cursor != null ? x(cursor) : null;
  const showCursor = cx != null && cx >= PAD.left - 0.5 && cx <= PAD.left + w + 0.5;
  const unitOf = (key: Key) => (key === 'speed' ? ' km/h' : key === 'throttle' ? ' %' : brakeUnit ? ` ${brakeUnit}` : '');
  const reading = (s: Side, i: number) => panels.map((p) => {
    const v = group[s][p.key][i];
    return v == null ? '–' : `${p.key === 'speed' ? v.toFixed(0) : Math.round(v)}${unitOf(p.key)}`;
  }).join(', ');
  const at = cursor != null ? x0 + cursor * step : null;
  // a corner taken flat has no apex: its distances are from the corner's official position
  const where = corner.flat ? corner.code : 'the apex';
  const place = (v: number | null) => (v == null ? '' : Math.round(v) === 0 ? `at ${where}` : `${fromApex(v)} ${where}`);
  const readout = cursor != null
    ? [`${place(at).replace(/^./, (ch) => ch.toUpperCase())}`, ...SIDES.map((s) => `${codes[s]} ${reading(s, cursor)}`)]
    : [`Slowest: ${SIDES.map((s) => `${codes[s]} ${group[s].min_speed?.toFixed(1) ?? '–'} km/h ` +
      place(group[s].min_speed_at)).map((v) => v.trim()).join(', ')}`];
  const described = `${corner.code}: ${panels.map((p) => p.title.toLowerCase()).join(', ')} of ${codes.a} and ` +
    `${codes.b} from ${fromApex(full[0])} to ${fromApex(full[1])} ${where}. ${readout.join('; ')}.`;

  return (
    <View style={styles.wrap}>
      <View style={styles.readRow}>
        <Text style={styles.readout} accessibilityLiveRegion="polite">{readout.join(' · ')}</Text>
        {!zoom.shared && <ResetZoom zoom={zoom} />}
      </View>
      <ZoomArea zoom={zoom} full={full} left={PAD.left} width={w} minSpan={least} onCursor={cursorAt}
        onLeave={() => setCursor(null)} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && n > 1 && (
          <Svg width={width} height={height} pointerEvents="none" accessibilityRole="image"
            accessibilityLabel={described}>
            {zoomed && (
              <Defs>
                <ClipPath id={clip}>
                  <Rect x={PAD.left} y={0} width={w} height={height} />
                </ClipPath>
              </Defs>
            )}
            {/* the apex, through all three panels */}
            {view[0] <= 0 && view[1] >= 0 && (
              <G>
                {panels.map((p, k) => (
                  <Line key={`apex${p.key}`} x1={mx(0)} x2={mx(0)} y1={tops[k]} y2={tops[k] + p.height}
                    stroke={c.axis} strokeOpacity={0.35} strokeWidth={1} />
                ))}
              </G>
            )}
            {panels.map((p, k) => {
              const top = tops[k];
              const y = yOf(k);
              return (
                <G key={p.key}>
                  <SvgText x={PAD.left} y={top - 8} fontSize={12} fontFamily={Fonts.label} fontWeight="700"
                    fill={c.ink2}>
                    {`${p.title.toUpperCase()}${p.unit ? `  ${p.unit}` : ''}`}
                  </SvgText>
                  <Line x1={PAD.left} x2={PAD.left + w} y1={top} y2={top} stroke={c.grid} strokeWidth={1} />
                  <Line x1={PAD.left} x2={PAD.left + w} y1={top + p.height} y2={top + p.height} stroke={c.axis}
                    strokeWidth={1} />
                  {p.domain.map((t) => (
                    <SvgText key={t} x={PAD.left - 5} y={y(t) + 4} fontSize={12} fontFamily={Fonts.label}
                      fill={c.ink2} textAnchor="end">
                      {t.toFixed(p.digits)}
                    </SvgText>
                  ))}
                  <G clipPath={zoomed ? `url(#${clip})` : undefined}>
                    {SIDES.map((s) => (
                      <Path key={s} d={pathOf(group[s][p.key], i0, i1, x, y)} stroke={colors[s]} strokeWidth={2}
                        fill="none" strokeLinejoin="round" strokeLinecap={s === 'b' ? 'butt' : 'round'}
                        strokeDasharray={s === 'b' ? DASH : undefined} />
                    ))}
                  </G>
                </G>
              );
            })}
            {marks.map((m) => (m.side === 'a'
              ? <Circle key={`${m.side}${m.key}`} cx={m.cx} cy={m.cy} r={MARK} fill={colors.a} stroke={c.surface}
                strokeWidth={2} />
              : <Rect key={`${m.side}${m.key}`} x={m.cx - MARK} y={m.cy - MARK} width={2 * MARK} height={2 * MARK}
                fill={colors.b} stroke={c.surface} strokeWidth={2} />))}
            {ends.map((e) => (
              <SvgText key={e.side} x={PAD.left + w + 5} y={e.y + 4} fontSize={12} fontFamily={Fonts.label}
                fontWeight="700" fill={c.ink}>
                {codes[e.side]}
              </SvgText>
            ))}
            {ticks.map((t) => (
              <SvgText key={`t${t}`} x={mx(t)} y={bottom + 16} fontSize={12} fontFamily={Fonts.label} fill={c.ink2}
                textAnchor="middle">
                {t === 0 ? (corner.flat ? corner.code : 'Apex') : `${t > 0 ? '+' : '−'}${Math.abs(t)}`}
              </SvgText>
            ))}
            {showCursor && <Line x1={cx} x2={cx} y1={tops[0]} y2={bottom} stroke={c.ink} strokeWidth={1} />}
          </Svg>
        )}
      </ZoomArea>
      <Text style={styles.axis}>
        {corner.flat ? `Metres from ${corner.code}, taken flat` : 'Metres from the apex'} (minus: before it)
      </Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  wrap: { gap: 6 },
  readRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', columnGap: 12 },
  readout: { fontFamily: face('label', 500), fontSize: 16, lineHeight: 22, color: c.textSecondary,
    fontVariant: ['tabular-nums'], minHeight: 44, flexShrink: 1 },
  axis: { fontFamily: face('label', 500), fontSize: 13, lineHeight: 18, color: c.textSecondary },
}));
