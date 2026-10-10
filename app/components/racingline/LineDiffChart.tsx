// The line difference: how far each lap's line is left (up) or right (down) of the first lap's, metre by metre round
// the lap, with the official corner numbers along the bottom. Each lap is drawn in its colour and its pattern; the
// first lap is the zero line. It zooms like the app's other charts (components/Zoom.tsx: pinch, wheel, a box dragged
// with the mouse, double tap for the whole lap); a tap or a click puts the 3D view's playhead there, and the ink line
// is the playhead.
import { useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet } from 'react-native';
import Svg, { ClipPath, Defs, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { Text, View } from '@/components/Themed';
import { LapKey } from '@/components/racingline/LapKey';
import { ResetZoom, useZoomState, ZoomArea, ZOOM_HINT } from '@/components/Zoom';
import { chartPlate, Fonts, themed, Type, useTheme } from '@/constants/Theme';
import type { RacingLine } from '@/lib/racingLine';
import { apexes, lateralWords, PATTERNS, placeCount } from '@/lib/racingLineMath';
import { isZoomed, pixelOf, Range, shownRange, valueAt } from '@/lib/zoom';

const PAD = { left: 56, right: 10, top: 10, bottom: 8 };
const LABELS = 26; // room for two rows of corner numbers

export function LineDiffChart({ data, colors, m, onSeek, height = 200 }: {
  data: RacingLine;
  colors: string[];
  m: number;
  onSeek: (m: number) => void;
  height?: number;
}) {
  const styles = useStyles();
  const c = useTheme().chart;
  const zoom = useZoomState(data.laps.map((l) => l.key).join());
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const n = placeCount(data);
  const step = data.step_m;
  const full: Range = [0, (n - 1) * step];
  const view = shownRange(zoom.view, full);
  const zoomed = isZoomed(view, full);
  const first = data.laps[0];
  const diffs = useMemo(() => data.laps.slice(1).map((l) => l.lateral.map((v, i) => v - first.lateral[i])),
    [data, first]);
  const i0 = Math.max(0, Math.floor(view[0] / step) - 1), i1 = Math.min(n - 1, Math.ceil(view[1] / step) + 1);
  let top = 0.5;
  for (const d of diffs) for (let i = i0; i <= i1; i++) if (Number.isFinite(d[i])) top = Math.max(top, Math.abs(d[i]));
  top = Math.ceil(top * 2) / 2;
  const w = Math.max(1, width - PAD.left - PAD.right);
  const h = height - PAD.top - PAD.bottom - LABELS;
  const x = (mm: number) => pixelOf(mm, view, PAD.left, w);
  const y = (v: number) => PAD.top + (1 - (v + top) / (2 * top)) * h;
  const paths = diffs.map((d) => {
    let s = '';
    let pen = false;
    for (let i = i0; i <= i1; i++) {
      if (!Number.isFinite(d[i])) {
        pen = false;
        continue;
      }
      s += `${pen ? 'L' : 'M'}${x(i * step).toFixed(1)},${y(d[i]).toFixed(1)}`;
      pen = true;
    }
    return s;
  });
  const corners = apexes(data).filter((k) => k.apex_m >= view[0] && k.apex_m <= view[1]);
  const lastX = [-Infinity, -Infinity];
  const placed = width ? corners.map((k) => {
    const px = x(k.apex_m);
    const row = px - lastX[0] >= 30 ? 0 : px - lastX[1] >= 30 ? 1 : -1;
    if (row >= 0) lastX[row] = px;
    return { ...k, px, row };
  }).filter((k) => k.row >= 0) : [];
  const at = (px: number) => Math.max(0, Math.min(full[1], valueAt(px, view, PAD.left, w)));
  const cursorM = hover ?? m;
  const ci = Math.round(cursorM / step);
  const px = x(m);

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.title}>{`Line against ${first.label}, metres left (up) or right (down)`}</Text>
        <ResetZoom zoom={zoom} />
      </View>
      <View style={styles.values}>
        <Text style={styles.at}>{`At ${Math.round(cursorM).toLocaleString('en-GB')} m${hover != null ? ' (pointer)' : ''}`}</Text>
        {data.laps.slice(1).map((l, k) => (
          <View key={l.key} style={styles.value}>
            <LapKey k={k + 1} color={colors[(k + 1) % colors.length]} width={26} />
            <Text style={styles.valueText}>{`${l.label}: ${lateralWords(diffs[k][ci])}`}</Text>
          </View>
        ))}
      </View>
      <ZoomArea zoom={zoom} full={full} left={PAD.left} width={w}
        onCursor={(cx) => setHover(at(cx))} onLeave={() => setHover(null)}
        onRelease={(_touch, cx) => {
          setHover(null);
          onSeek(at(cx));
        }}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        <View accessible accessibilityRole="image"
          accessibilityLabel={`Chart of each lap's line against ${first.label}. Tap a place to move the 3D view there.`}>
          {width > 0 && (
            <Svg width={width} height={height} pointerEvents="none">
              {zoomed && (
                <Defs>
                  <ClipPath id="rl-diff">
                    <Rect x={PAD.left} y={0} width={w} height={height} />
                  </ClipPath>
                </Defs>
              )}
              {[top, top / 2, -top / 2, -top].map((v) => (
                <Line key={v} x1={PAD.left} x2={PAD.left + w} y1={y(v)} y2={y(v)} stroke={c.grid} strokeWidth={1} />
              ))}
              <SvgText x={PAD.left - 5} y={y(top) + 9} fontSize={12} fill={c.muted} textAnchor="end" fontFamily={Fonts.sans}>
                {`${top.toFixed(1)} L`}
              </SvgText>
              <SvgText x={PAD.left - 5} y={y(-top)} fontSize={12} fill={c.muted} textAnchor="end" fontFamily={Fonts.sans}>
                {`${top.toFixed(1)} R`}
              </SvgText>
              <SvgText x={PAD.left - 5} y={y(0) + 4} fontSize={12} fill={c.ink2} textAnchor="end" fontFamily={Fonts.sans}>
                0
              </SvgText>
              {placed.map((k) => (
                <G key={k.code}>
                  <Line x1={k.px} x2={k.px} y1={PAD.top} y2={PAD.top + h} stroke={c.grid} strokeWidth={1} />
                  <SvgText x={k.px} y={PAD.top + h + 14 + k.row * 13} fontSize={12} fill={c.ink2} textAnchor="middle"
                    fontFamily={Fonts.sans}>{k.code}</SvgText>
                </G>
              ))}
              <G clipPath={zoomed ? 'url(#rl-diff)' : undefined}>
                <Line x1={PAD.left} x2={PAD.left + w} y1={y(0)} y2={y(0)} stroke={colors[0]} strokeWidth={2.5} />
                {paths.map((d, k) => (
                  <Path key={k} d={d} stroke={colors[(k + 1) % colors.length]} strokeWidth={2.5} fill="none"
                    strokeDasharray={PATTERNS[(k + 1) % PATTERNS.length].svg} strokeLinejoin="round" />
                ))}
              </G>
              {hover != null && x(hover) >= PAD.left && x(hover) <= PAD.left + w && (
                <Line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + h} stroke={c.muted} strokeWidth={1}
                  strokeDasharray="3,3" />
              )}
              {px >= PAD.left && px <= PAD.left + w && (
                <Line x1={px} x2={px} y1={PAD.top} y2={PAD.top + h} stroke={c.ink} strokeWidth={2} />
              )}
            </Svg>
          )}
        </View>
      </ZoomArea>
      <Text style={styles.hint}>{`${ZOOM_HINT} Tap or click a place to move the 3D view there.`}</Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  wrap: { gap: 6, ...chartPlate(c) },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', columnGap: 12,
    borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 4, minHeight: 24 },
  title: { ...Type.label, fontSize: 13, color: c.text, flexShrink: 1 },
  values: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 4, alignItems: 'center' },
  at: { ...Type.number, fontSize: 16, color: c.textSecondary },
  value: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  valueText: { ...Type.number, fontSize: 16, color: c.text },
  hint: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.textSecondary },
}));
