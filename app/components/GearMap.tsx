// The gear map of the race weekend's Before view: the best lap at the venue drawn north up, the track coloured by the
// gear held at each point, the gear number on the track at every corner it is braked for (and on the long runs), an
// ink tick across the track where each braking starts, and the official corner numbers beside the track. Colour and
// number together, never colour alone: every coloured run that matters carries its number, and the legend repeats it.
// It zooms like the track map (components/Zoom.tsx ZoomPlane): both ways at once, keeping its shape.
import { useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { Text, View } from '@/components/Themed';
import { useWide } from '@/components/Programme';
import { ResetZoom, usePlaneZoom, ZoomPlane } from '@/components/Zoom';
import { gearName, GuideMap } from '@/lib/guide';
import { Box, leaderEnd, MapPoint, Placed, placeLabels } from '@/lib/trackmap';
import { Plane, Point, toFrame } from '@/lib/zoom';
import { face, Fonts, inkOn, themed, Type, useTheme } from '@/constants/Theme';

const PAD = 36; // room round the track for the corner labels

type Run = { gear: number | null; i0: number; i1: number; d: string };
type Badge = { gear: number; p: MapPoint; box: Box };

const line = (pts: MapPoint[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
const unit = (x: number, y: number) => {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
};

/** CIE lightness (0–100) of a #rrggbb colour. */
function lightness(hex: string) {
  const [r, g, b] = [1, 3, 5].map((k) => {
    const v = parseInt(hex.slice(k, k + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

/** The colours of the gears used here, lowest first, from the speed ramp (slow near the paper, fast deep): as many of
 * its steps as there are gears, in order, picked so that neighbouring gears differ most in lightness (the ramp's
 * deepest steps are close to each other, so two of them would read as one gear). */
function gearColours(gears: number[], ramp: string[]): Map<number, string> {
  const k = gears.length;
  const out = new Map<number, string>();
  if (!k) return out;
  if (k === 1 || k > ramp.length) {
    gears.forEach((g, i) => out.set(g, ramp[k === 1 ? Math.floor(ramp.length / 2)
      : Math.round((i / (k - 1)) * (ramp.length - 1))]));
    return out;
  }
  const l = ramp.map(lightness);
  let best: number[] = [], score = -1;
  const pick = (from: number, chosen: number[]) => {
    if (chosen.length === k) {
      const least = Math.min(...chosen.slice(1).map((s, i) => Math.abs(l[s] - l[chosen[i]])));
      if (least > score) [best, score] = [chosen, least];
      return;
    }
    for (let s = from; s <= ramp.length - (k - chosen.length); s++) pick(s + 1, [...chosen, s]);
  };
  pick(0, []);
  gears.forEach((g, i) => out.set(g, ramp[best[i]]));
  return out;
}

/** A corner label placed on the whole map, moved with its corner on the zoomed one (`at`: where a point is drawn). */
function moveLabel(l: Placed, at: (p: Point) => Point): Placed {
  const a = at(l.anchor);
  return { ...l, anchor: a, box: { ...l.box, x: l.box.x + a.x - l.anchor.x, y: l.box.y + a.y - l.anchor.y } };
}

// The drawing, zoomed by `view` (both ways, keeping the track's shape: lib/zoom.ts) when it is given. The lines, the
// gear numbers and the labels keep their size; zoomed in, the gear numbers that had no room on the whole map appear
// where they now fit. The corner labels are placed once, on the whole map, and move with their corners.
function layout(map: GuideMap, width: number, maxHeight: number, wide: boolean, view: Plane | null = null) {
  const z = wide ? { track: 8, badge: 11, font: 13, num: 13 } : { track: 6, badge: 10, font: 12, num: 12 };
  const x0 = Math.min(...map.x), x1 = Math.max(...map.x);
  const y0 = Math.min(...map.y), y1 = Math.max(...map.y);
  const s = Math.max(0.01, Math.min((width - 2 * PAD) / (x1 - x0 || 1), (maxHeight - 2 * PAD) / (y1 - y0 || 1)));
  const height = Math.round((y1 - y0) * s + 2 * PAD);
  const left = (width - (x1 - x0) * s) / 2;
  const px = (p: MapPoint) => toFrame(view, width, height, { x: left + (p.x - x0) * s, y: PAD + (y1 - p.y) * s });
  const pts = map.x.map((x, i) => px({ x, y: map.y[i] }));
  const n = pts.length;
  const pt = (i: number) => pts[((i % n) + n) % n];
  const at = (m: number) => Math.round(m / map.step_m);

  // the lap cut into runs of one gear, each sharing its end point with the next; the last one closes the loop
  const gears = map.gear ?? pts.map(() => null);
  const runs: Run[] = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || gears[i] !== gears[start]) {
      const run: MapPoint[] = [];
      for (let j = start; j <= i; j++) run.push(pt(j));
      runs.push({ gear: gears[start], i0: start, i1: i, d: line(run) });
      start = i;
    }
  }

  // the gear numbers: first the gear each braking zone ends in (the corner's gear), then the long runs, never two
  // badges on top of each other
  const r = z.badge;
  const badges: Badge[] = [];
  const free = (p: MapPoint) => badges.every((b) => Math.hypot(b.p.x - p.x, b.p.y - p.y) >= 2 * r + 3);
  const add = (run: Run | undefined) => {
    if (!run || run.gear == null) return;
    const p = pt(Math.round((run.i0 + run.i1) / 2));
    if (badges.some((b) => b.gear === run.gear && Math.hypot(b.p.x - p.x, b.p.y - p.y) < 1)) return;
    if (free(p)) badges.push({ gear: run.gear, p, box: { x: p.x - r - 2, y: p.y - r - 2, w: 2 * r + 4, h: 2 * r + 4 } });
  };
  const runAt = (i: number) => runs.find((u) => i >= u.i0 && i < u.i1) ?? runs[runs.length - 1];
  for (const b of map.braking) add(runAt(Math.min(at(b.end_m) + 1, n - 1)));
  const longest = [...runs].sort((a, b) => b.i1 - b.i0 - (a.i1 - a.i0));
  const minRun = Math.ceil((wide ? 120 : 180) / (view?.k ?? 1) / map.step_m); // as long on the screen when zoomed
  for (const run of longest) if (run.i1 - run.i0 >= minRun) add(run);

  // where each braking starts: a tick across the track
  const ticks = map.braking.map((b) => {
    const p = px({ x: b.x, y: b.y });
    const t = unit(b.dx, -b.dy); // screen y runs down
    const half = z.track / 2 + 7;
    return { a: { x: p.x - t.y * half, y: p.y + t.x * half }, b: { x: p.x + t.y * half, y: p.y - t.x * half } };
  });

  // start/finish: a bar across the track at the line, the arrow of the direction of travel beside it on the outside
  const s0 = pts[0];
  const dir = unit(map.start.dx, -map.start.dy);
  const cx = pts.reduce((a, p) => a + p.x, 0) / n, cy = pts.reduce((a, p) => a + p.y, 0) / n;
  let side = { x: -dir.y, y: dir.x };
  if ((s0.x - cx) * side.x + (s0.y - cy) * side.y < 0) side = { x: -side.x, y: -side.y };
  const bar = { a: { x: s0.x - side.x * (z.track / 2 + 5), y: s0.y - side.y * (z.track / 2 + 5) },
    b: { x: s0.x + side.x * (z.track / 2 + 5), y: s0.y + side.y * (z.track / 2 + 5) } };
  const a0 = { x: s0.x + side.x * 16 + dir.x * 3, y: s0.y + side.y * 16 + dir.y * 3 };
  const a1 = { x: a0.x + dir.x * 20, y: a0.y + dir.y * 20 };
  const head = (turn: number) => ({
    x: a1.x - 6 * (dir.x * Math.cos(turn) - dir.y * Math.sin(turn)),
    y: a1.y - 6 * (dir.x * Math.sin(turn) + dir.y * Math.cos(turn)),
  });
  const arrow = line([a0, a1]) + line([head(0.5), a1, head(-0.5)]);
  const around = (ps: MapPoint[], m: number): Box => {
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    return { x: Math.min(...xs) - m, y: Math.min(...ys) - m, w: Math.max(...xs) - Math.min(...xs) + 2 * m,
      h: Math.max(...ys) - Math.min(...ys) + 2 * m };
  };

  // the corner numbers off the track, clear of the badges and the start/finish marks (official ones only; a track
  // without them shows the analysis' own C1, C2...)
  const named = map.corners.length
    ? map.corners.map((c) => ({ code: c.code, anchor: px({ x: c.x, y: c.y }) }))
    : map.sections.filter((s) => s.apex).map((s) => ({ code: s.code, anchor: px(s.apex!) }));
  const labels = view ? [] : placeLabels(named, pts, { width, height }, {
    fontSize: z.font, clearance: z.track / 2 + 4,
    obstacles: [...badges.map((b) => b.box), around([bar.a, bar.b], 2), around([a0, a1, head(0.5), head(-0.5)], 2)],
  });
  return { width, height, z, runs, badges, ticks, bar, arrow, labels, loop: line([...pts, pts[0]]) };
}

/** The gear map of the best lap here. asLogged: the gear numbers are the log's own (first gear wasn't found). */
export default function GearMap({ map, caption, asLogged }: { map: GuideMap; caption?: string; asLogged?: boolean }) {
  const styles = useStyles();
  const theme = useTheme();
  const c = theme.chart;
  const wide = useWide();
  const [width, setWidth] = useState(0);
  const maxHeight = wide ? 560 : 440;
  // the map zooms both ways: the wheel or a pinch, a box dragged across it, a drag once zoomed (components/Zoom.tsx);
  // another lap or another width starts on the whole map
  const zoom = usePlaneZoom(`${map.length_m}:${map.x.length}:${map.x[0]}:${width}:${wide}`);
  const whole = useMemo(() => (width > 0 ? layout(map, width, maxHeight, wide) : null), [map, width, maxHeight, wide]);
  const g = useMemo(() => {
    if (!whole || !zoom.view) return whole;
    const at = (p: Point) => toFrame(zoom.view, whole.width, whole.height, p);
    return { ...layout(map, width, maxHeight, wide, zoom.view), labels: whole.labels.map((l) => moveLabel(l, at)) };
  }, [whole, map, width, maxHeight, wide, zoom.view]);
  const used = useMemo(() => [...new Set((map.gear ?? []).filter((x): x is number => x != null))].sort((a, b) => a - b),
    [map.gear]);
  const colours = useMemo(() => gearColours(used, c.speed), [used, c.speed]);
  const fill = (gear: number | null) => (gear == null ? c.muted : colours.get(gear) ?? c.muted);
  const name = (gear: number) => (asLogged ? `gear ${gear}` : gearName(gear));
  const described = `Gear map of the best lap: ${map.corners.length
    ? map.corners.map((k) => `${k.code} ${k.gear != null ? name(k.gear) : 'no gear'}`).join(', ')
    : map.sections.map((k) => `${k.code} ${k.gear != null ? name(k.gear) : ''}`).join(', ')}. ` +
    `Braking starts at ${map.braking.map((b) => `${b.start_m} m`).join(', ')}.`;

  return (
    <View style={styles.wrap}>
      {used.length > 0 && (
        <View style={styles.legend} accessibilityRole="text"
          accessibilityLabel={`Gears: ${used.map(name).join(', ')}, from the paler to the deeper blue`}>
          <Text style={styles.legendLabel}>{asLogged ? 'Gear as logged' : 'Gear'}</Text>
          <View style={styles.swatches}>
            {used.map((x) => (
              <View key={x} style={StyleSheet.flatten([styles.swatch, { backgroundColor: fill(x) }])}>
                <Text style={StyleSheet.flatten([styles.swatchText, { color: inkOn(fill(x)) }])}>{x}</Text>
              </View>
            ))}
          </View>
          <View style={styles.tickKey}>
            <View style={styles.tick} />
            <Text style={styles.legendText}>Braking starts</Text>
          </View>
          <ResetZoom zoom={zoom} reserve />
        </View>
      )}
      {!used.length && <ResetZoom zoom={zoom} reserve />}
      <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        {!g && <Text style={styles.note}>Drawing the gear map…</Text>}
        {g && (
          <ZoomPlane zoom={zoom} width={g.width} height={g.height}>
            <Svg width={g.width} height={g.height} pointerEvents="none" accessibilityRole="image"
              accessibilityLabel={described}>
              <Path d={g.loop} stroke={c.ink} strokeWidth={g.z.track + 4} fill="none" strokeLinejoin="round" />
              {g.runs.map((r, i) => (
                <Path key={i} d={r.d} stroke={fill(r.gear)} strokeWidth={g.z.track} fill="none" strokeLinejoin="round" />
              ))}
              {g.ticks.map((t, i) => (
                <Line key={`h${i}`} x1={t.a.x} y1={t.a.y} x2={t.b.x} y2={t.b.y} stroke={c.surface} strokeWidth={6}
                  strokeLinecap="round" />
              ))}
              {g.ticks.map((t, i) => (
                <Line key={`t${i}`} x1={t.a.x} y1={t.a.y} x2={t.b.x} y2={t.b.y} stroke={c.ink} strokeWidth={2.5}
                  strokeLinecap="round" />
              ))}
              <Line x1={g.bar.a.x} y1={g.bar.a.y} x2={g.bar.b.x} y2={g.bar.b.y} stroke={c.ink} strokeWidth={4} />
              <Path d={g.arrow} stroke={c.ink} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              {g.labels.map((l) => {
                const end = leaderEnd(l);
                return l.leader ? (
                  <Line key={`l${l.code}`} x1={l.anchor.x} y1={l.anchor.y} x2={end.x} y2={end.y} stroke={c.ink2}
                    strokeWidth={1} />
                ) : null;
              })}
              {g.badges.map((b, i) => (
                <Circle key={`c${i}`} cx={b.p.x} cy={b.p.y} r={g.z.badge} fill={fill(b.gear)} stroke={c.surface}
                  strokeWidth={2} />
              ))}
              {g.badges.map((b, i) => (
                <SvgText key={`n${i}`} x={b.p.x} y={b.p.y + g.z.num * 0.36} fontSize={g.z.num} fontFamily={Fonts.label}
                  fontWeight="700" fill={inkOn(fill(b.gear))} textAnchor="middle">
                  {b.gear}
                </SvgText>
              ))}
              {g.labels.map((l) => (
                <SvgText key={l.code} x={l.box.x + l.box.w / 2} y={l.box.y + l.box.h - 3} fontSize={g.z.font}
                  fontFamily={Fonts.label} fontWeight="700" fill={c.ink} textAnchor="middle">
                  {l.code}
                </SvgText>
              ))}
            </Svg>
          </ZoomPlane>
        )}
      </View>
      {!map.gear && (
        <Text style={styles.note}>The logs have no gear channel here: the map shows where the braking starts.</Text>
      )}
      {asLogged && map.gear && (
        <Text style={styles.note}>Gears as the logger numbers them: first gear couldn&apos;t be found in the log.</Text>
      )}
      {caption ? <Text style={styles.note}>{caption}</Text> : null}
    </View>
  );
}

const useStyles = themed((c) => ({
  wrap: { gap: 10 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 8 },
  legendLabel: { ...Type.label, fontSize: 13, color: c.text },
  legendText: { fontFamily: face('label', 600), fontSize: 14, color: c.text },
  swatches: { flexDirection: 'row', gap: 2 },
  swatch: { minWidth: 30, height: 26, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  swatchText: { fontFamily: face('label', 700), fontSize: 15, fontVariant: ['tabular-nums'] },
  tickKey: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tick: { width: 3, height: 18, backgroundColor: c.text },
  note: { fontFamily: face('body', 400, true), fontSize: 15, lineHeight: 21, color: c.textSecondary },
}));
