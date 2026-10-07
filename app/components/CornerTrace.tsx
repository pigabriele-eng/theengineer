// One corner's technique graph: the speed through it, with the throttle and the brake beneath on the same distance, for
// two passes: the best pass here (solid, the first series colour) and a typical pass (dashed, grey). The official corner
// numbers mark their place across all three. Touch or hover to read the values at a point; without, the readout gives
// each pass's slowest speed and the gear there. Line style and colour together: never colour alone. It zooms like the
// other charts (components/Zoom.tsx): the three panels together along the distance, the speed axis fitting what is shown.
import { useId, useMemo, useState } from 'react';
import { LayoutChangeEvent } from 'react-native';
import Svg, { ClipPath, Defs, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { Text, View } from '@/components/Themed';
import { ResetZoom, useZoom, ZoomArea } from '@/components/Zoom';
import { gearName, GuideCorner, GuidePass } from '@/lib/guide';
import { isZoomed, pixelOf, Range, shownRange, valueAt } from '@/lib/zoom';
import { face, Fonts, themed, useTheme } from '@/constants/Theme';

const PAD = { left: 40, right: 10, top: 20 }; // top: the corner numbers' row
const GAP = 34; // between the panels: their titles sit in it
const DASH = '7 5';
const LEAST_POINTS = 6; // the narrowest zoom, in grid steps

type Panel = { key: 'speed' | 'throttle' | 'brake'; title: string; unit: string; height: number;
  domain: [number, number]; ticks: number[]; digits: number };

const finite = (v: (number | null)[] | null | undefined) =>
  (v ?? []).filter((x): x is number => x != null && Number.isFinite(x));

/** The pass's values from point i0 to i1 as an SVG path, broken where a value is missing. */
function pathOf(values: (number | null)[], i0: number, i1: number, x: (i: number) => number,
  y: (v: number) => number) {
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

const slowest = (p: GuidePass) => {
  let k = -1;
  (p.speed ?? []).forEach((v, i) => {
    if (v != null && (k < 0 || v < p.speed![k]!)) k = i;
  });
  return k;
};

export default function CornerTrace({ corner, step, brakeUnit, wide }: { corner: GuideCorner; step: number;
  brakeUnit?: string | null; wide: boolean }) {
  const styles = useStyles();
  const c = useTheme().chart;
  const zoom = useZoom();
  const clip = `clip${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const best = corner.best!, typical = corner.typical!;
  const n = Math.max(best.speed?.length ?? 0, typical.speed?.length ?? 0);
  const x0 = corner.x0_m ?? corner.start_m;
  const full: Range = [x0, x0 + Math.max(n - 1, 1) * step];
  const least = LEAST_POINTS * step;
  const view = shownRange(zoom.view, full, least);
  const zoomed = isZoomed(view, full);
  // the points that draw the view: those inside it and one either side (clipped at the edges)
  const i0 = Math.max(0, Math.floor((view[0] - x0) / step) - 1);
  const i1 = Math.min(n - 1, Math.ceil((view[1] - x0) / step) + 1);

  const panels = useMemo<Panel[]>(() => {
    // the speed axis fits the part shown: zoomed into the slowest point, its few km/h fill the panel
    const sp = [...finite(best.speed?.slice(i0, i1 + 1)), ...finite(typical.speed?.slice(i0, i1 + 1))];
    const round = zoomed ? 5 : 20;
    let lo = sp.length ? Math.floor(Math.min(...sp) / round) * round : 0;
    let hi = sp.length ? Math.ceil(Math.max(...sp) / round) * round : round;
    if (!(hi > lo)) [lo, hi] = [lo - round, hi + round];
    const br = [...finite(best.brake), ...finite(typical.brake)];
    const top = br.length ? Math.max(...br.map(Math.abs)) : 0;
    const brakeTop = top > 0 ? Math.ceil(top / 10) * 10 : 1;
    const out: Panel[] = [{ key: 'speed', title: 'Speed', unit: 'km/h', height: wide ? 150 : 130, domain: [lo, hi],
      ticks: [lo, hi], digits: 0 }];
    if (best.throttle || typical.throttle) {
      out.push({ key: 'throttle', title: 'Throttle', unit: '%', height: wide ? 56 : 50, domain: [0, 100],
        ticks: [0, 100], digits: 0 });
    }
    if (br.length) {
      out.push({ key: 'brake', title: 'Brake', unit: brakeUnit ?? '', height: wide ? 56 : 50,
        domain: [0, brakeTop], ticks: [0, brakeTop], digits: 0 });
    }
    return out;
  }, [best, typical, brakeUnit, wide, i0, i1, zoomed]);

  const w = Math.max(width - PAD.left - PAD.right, 1);
  const x = (i: number) => pixelOf(x0 + i * step, view, PAD.left, w);
  const mx = (m: number) => pixelOf(m, view, PAD.left, w);
  const tops: number[] = [];
  let y0 = PAD.top;
  for (const p of panels) {
    tops.push(y0);
    y0 += p.height + GAP;
  }
  const height = y0 - GAP + 4;
  const marks = corner.marks.filter((k) => k.at_m >= view[0] && k.at_m <= view[1]);
  const cursorAt = (px: number) =>
    setCursor(Math.max(0, Math.min(n - 1, Math.round((valueAt(px, view, PAD.left, w) - x0) / step))));
  const cx = cursor != null ? x(cursor) : null;
  const showCursor = cx != null && cx >= PAD.left - 0.5 && cx <= PAD.left + w + 0.5;

  const value = (p: GuidePass, key: Panel['key'], i: number) => {
    const v = p[key]?.[i];
    return v == null ? '–' : `${Math.abs(v).toFixed(0)}${key === 'speed' ? ' km/h' : key === 'throttle' ? ' %'
      : brakeUnit ? ` ${brakeUnit}` : ''}`;
  };
  const gearAt = (p: GuidePass, i: number) => (p.gear?.[i] != null ? `, ${gearName(p.gear[i]!)}` : '');
  const at = (p: GuidePass, i: number) => panels.map((q) => value(p, q.key, i)).join(', ') + gearAt(p, i);
  const kb = slowest(best), kt = slowest(typical);
  const readout = cursor != null
    ? [`At ${x0 + cursor * step} m`, `best ${at(best, cursor)}`, `typical ${at(typical, cursor)}`]
    : [kb >= 0 ? `Slowest: best ${best.speed![kb]!.toFixed(0)} km/h at ${x0 + kb * step} m${gearAt(best, kb)}` : '',
      kt >= 0 ? `typical ${typical.speed![kt]!.toFixed(0)} km/h at ${x0 + kt * step} m${gearAt(typical, kt)}` : '']
      .filter(Boolean);
  const described = `${corner.code}: speed${panels.length > 1 ? ', throttle and brake' : ''} from ${corner.start_m} to ` +
    `${corner.end_m} m. ${readout.join('; ')}.`;

  return (
    <View style={styles.wrap}>
      <View style={styles.keys}>
        <View style={styles.key}>
          <Svg width={26} height={10}><Line x1={1} x2={25} y1={5} y2={5} stroke={c.series[0]} strokeWidth={2.5} /></Svg>
          <Text style={styles.keyText}>
            Best pass {best.time.toFixed(2)} s · {best.session} lap {best.lap}{best.year ? `, ${best.year}` : ''}
            {best.driver ? ` · ${best.driver}` : ''}
          </Text>
        </View>
        <View style={styles.key}>
          <Svg width={26} height={10}>
            <Line x1={1} x2={25} y1={5} y2={5} stroke={c.muted} strokeWidth={2.5} strokeDasharray={DASH} />
          </Svg>
          <Text style={styles.keyText}>
            Typical pass {typical.time.toFixed(2)} s · {typical.session} lap {typical.lap}
          </Text>
        </View>
      </View>
      <View style={styles.readRow}>
        <Text style={styles.readout} accessibilityLiveRegion="polite">{readout.join(' · ')}</Text>
        {!zoom.shared && <ResetZoom zoom={zoom} />}
      </View>
      <ZoomArea zoom={zoom} full={full} view={view} left={PAD.left} width={w} minSpan={least} onCursor={cursorAt}
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
            {marks.map((k) => (
              <Line key={`m${k.code}`} x1={mx(k.at_m)} x2={mx(k.at_m)} y1={PAD.top - 4} y2={height - 4}
                stroke={c.grid} strokeWidth={1} />
            ))}
            {marks.map((k) => (
              <SvgText key={`t${k.code}`} x={mx(k.at_m)} y={PAD.top - 7} fontSize={12} fontFamily={Fonts.label}
                fontWeight="700" fill={c.ink2} textAnchor="middle">
                {k.code}
              </SvgText>
            ))}
            {panels.map((p, k) => {
              const top = tops[k];
              const y = (v: number) => top + (1 - (Math.abs(v) - p.domain[0]) / (p.domain[1] - p.domain[0] || 1)) *
                p.height;
              return (
                <G key={p.key}>
                  <SvgText x={PAD.left} y={top - 8} fontSize={12} fontFamily={Fonts.label} fontWeight="700"
                    fill={c.ink2}>
                    {`${p.title.toUpperCase()}${p.unit ? `  ${p.unit}` : ''}`}
                  </SvgText>
                  <Line x1={PAD.left} x2={width - PAD.right} y1={top} y2={top} stroke={c.grid} strokeWidth={1} />
                  <Line x1={PAD.left} x2={width - PAD.right} y1={top + p.height} y2={top + p.height} stroke={c.axis}
                    strokeWidth={1} />
                  {p.ticks.map((t) => (
                    <SvgText key={t} x={PAD.left - 5} y={y(t) + 4} fontSize={12} fontFamily={Fonts.label}
                      fill={c.ink2} textAnchor="end">
                      {t.toFixed(p.digits)}
                    </SvgText>
                  ))}
                  <G clipPath={zoomed ? `url(#${clip})` : undefined}>
                    <Path d={pathOf(typical[p.key] ?? [], i0, i1, x, y)} stroke={c.muted} strokeWidth={2} fill="none"
                      strokeDasharray={DASH} strokeLinejoin="round" />
                    <Path d={pathOf(best[p.key] ?? [], i0, i1, x, y)} stroke={c.series[0]} strokeWidth={2}
                      fill="none" strokeLinejoin="round" strokeLinecap="round" />
                  </G>
                </G>
              );
            })}
            {showCursor && (
              <Line x1={cx} x2={cx} y1={PAD.top - 2} y2={height - 4} stroke={c.ink} strokeWidth={1} />
            )}
          </Svg>
        )}
      </ZoomArea>
      <Text style={styles.axis}>
        Metres from the start/finish line: {zoomed
          ? `${Math.round(view[0])}–${Math.round(view[1])} m shown of ${corner.start_m}–${corner.end_m} m`
          : `${corner.start_m}–${corner.end_m} m`}
      </Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  wrap: { gap: 6 },
  keys: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 4 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  keyText: { fontFamily: face('label', 600), fontSize: 14, lineHeight: 19, color: c.text, flexShrink: 1 },
  readRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', columnGap: 12 },
  readout: { fontFamily: face('label', 500), fontSize: 14, lineHeight: 19, color: c.textSecondary,
    fontVariant: ['tabular-nums'], minHeight: 38, flexShrink: 1 },
  axis: { fontFamily: face('label', 500), fontSize: 13, lineHeight: 18, color: c.textSecondary },
}));

/** Whether a corner has both passes to draw. */
export const cornerTraceReady = (k: GuideCorner) =>
  !!k.best && !!k.typical && (k.best.speed?.length ?? 0) > 1 && (k.typical.speed?.length ?? 0) > 1;
