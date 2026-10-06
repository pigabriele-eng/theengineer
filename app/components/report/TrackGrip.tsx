import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  GestureResponderEvent,
  LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Svg, { Circle, Line, Polyline, Text as SvgText } from 'react-native-svg';

import { Text, useThemeColor } from '@/components/Themed';
import { useSeriesColors } from '@/components/TraceChart';
import { formatLap } from '@/lib/api';
import { fetchTrackGrip, GripSession, pct, TrackGripAnswer, TrackGripResult } from '@/lib/trackGrip';

const MUTED = '#898781'; // de-emphasis gray of the chart palette (the same step in light and dark)
const POLL_MS = 4000;
const C = { left: 44, right: 12, top: 22, bottom: 44, height: 230 };
const CHAR_W = 6; // rough width of one character at fontSize 10
// SVG text takes the browser's default (serif) face on web: give it the system sans the rest of the app uses
const SVG_FONT = Platform.OS === 'web' ? 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' : undefined;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KIND: Record<string, string> = { qualifying: 'qualifying', race: 'race', other: 'practice or test' };

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const dayLabel = (iso: string | null) => {
  const d = day(iso);
  return d.length === 10 ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1] ?? ''}` : '';
};
const clock = (iso: string | null) => (iso && iso.length >= 16 ? iso.slice(11, 16) : '');

/** The event report's track grip section: how the track's grip moved session by session in time order, with the
 * tyres' state taken out, and the plain-words read of it. Waits (and asks again) while the report reads the logs. */
export function TrackGrip({ event }: { event: number }) {
  const [answer, setAnswer] = useState<TrackGripAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    try {
      const a = await fetchTrackGrip(event);
      setAnswer(a);
      setError(null);
      return a.status === 'waiting';
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [event]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setBusy(true);
    setAnswer(null);
    const tick = async () => {
      const again = await load();
      if (live && again) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const result = answer?.result;
  return (
    <View style={styles.wrap}>
      <Text style={styles.h2}>Track grip</Text>
      <Text style={styles.dim}>
        Grip at the limit session by session{answer ? ` (${answer.car.label})` : ''}, with the tyres&apos; state taken
        out: the rest is the track rubbering in, its temperature and the weather.
      </Text>
      {busy && (
        <View style={styles.loading}>
          <ActivityIndicator />
          <Text style={styles.dim}>Comparing every session&apos;s laps…</Text>
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      {answer && answer.status !== 'ready' && answer.reason && (
        <View style={styles.loading}>
          {answer.status === 'waiting' && <ActivityIndicator />}
          <Text style={styles.dim}>{answer.reason}</Text>
        </View>
      )}
      {result && !result.available && result.notes.map((n) => <Text key={n} style={styles.dim}>{n}</Text>)}
      {result && result.available && <Body result={result} />}
    </View>
  );
}

export default TrackGrip;

function Body({ result }: { result: TrackGripResult }) {
  const tint = useThemeColor({}, 'tint');
  const [first, ...rest] = result.read;
  return (
    <>
      {first && (
        <View style={StyleSheet.flatten([styles.callout, { borderColor: tint }])}>
          <Text style={styles.calloutText}>{first}</Text>
        </View>
      )}
      <GripChart sessions={result.sessions} base={result.base ?? result.sessions[0]?.name ?? ''} />
      {rest.map((r) => <Text key={r} style={styles.para}>{r}</Text>)}
      {result.notes.map((n) => <Text key={n} style={styles.dim}>{n}</Text>)}
      <Method result={result} />
    </>
  );
}

function Method({ result }: { result: TrackGripResult }) {
  const [open, setOpen] = useState(false);
  const b = result.basis;
  return (
    <View style={styles.method}>
      <Pressable accessibilityRole="button" onPress={() => setOpen(!open)}>
        <Text style={styles.toggle}>{open ? 'Hide how this is worked out' : 'How this is worked out'}</Text>
      </Pressable>
      {open && result.method.map((m) => <Text key={m} style={styles.dim}>{m}</Text>)}
      {open && b && (
        <Text style={styles.dim}>
          Here: {b.laps} quick laps compared over {b.limit_m} m of the {b.length_m} m lap
          {b.road_load ? ', per unit of the road’s load' : ''}.
        </Text>
      )}
    </View>
  );
}

function niceStep(span: number) {
  for (const s of [0.5, 1, 2, 5, 10]) if (span / s <= 6) return s;
  return 20;
}

/** The track's grip level of each session in time order against the first (0): a dot per session with its 90 %
 * range, the sessions joined in order, the days apart, and the air temperature under each. One series, so no
 * legend; touch or point at a session for its numbers; the same as a table on request. */
export function GripChart({ sessions, base, title }: { sessions: GripSession[]; base: string; title?: string }) {
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const ink = useThemeColor({}, 'text');
  const surface = useThemeColor({}, 'background');
  const accent = useSeriesColors().reference;
  const n = sessions.length;
  if (!n) return null;

  const vals = sessions.flatMap((s) => [s.track, ...(s.range ?? [])]).concat([0]);
  const step = niceStep(Math.max(...vals) - Math.min(...vals) || 1);
  const lo = Math.floor((Math.min(...vals) - step / 4) / step) * step;
  const hi = Math.ceil((Math.max(...vals) + step / 4) / step) * step;
  const w = Math.max(width - C.left - C.right, 1);
  const h = C.height - C.top - C.bottom;
  const col = w / n;
  const x = (i: number) => C.left + (i + 0.5) * col;
  const y = (v: number) => C.top + (1 - (v - lo) / (hi - lo)) * h;
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
  const longest = Math.max(...sessions.map((s) => s.name.length)) * CHAR_W + 6;
  const every = Math.max(1, Math.ceil(longest / Math.max(col, 1)));
  const newDay = sessions.map((s, i) => i === 0 || day(s.start) !== day(sessions[i - 1].start));
  const days = new Set(sessions.map((s) => day(s.start))).size;
  const withAir = sessions.some((s) => s.ambient_c != null);

  const nearest = (px: number) => {
    const i = Math.floor((px - C.left) / col);
    return i >= 0 && i < n ? i : null;
  };
  const touch = (e: GestureResponderEvent) => setPicked(nearest(e.nativeEvent.locationX));
  const hover = Platform.OS === 'web'
    ? {
        onMouseMove: (e: any) => setPicked(nearest(e.nativeEvent.offsetX ?? e.nativeEvent.locationX)),
        onMouseLeave: () => setPicked(null),
      }
    : {};
  const p = picked != null ? sessions[picked] : null;
  const summary = sessions.map((s) => `${s.name} ${pct(s.track)}`).join(', ');

  return (
    <View style={styles.chart}>
      <Text style={styles.chartTitle}>{title ?? `Track grip by session, % against ${base}`}</Text>
      <Text style={styles.readout} numberOfLines={3}>
        {p ? readout(p, base)
          : Platform.OS === 'web' ? 'Point at a session for its numbers.' : 'Touch a session for its numbers.'}
      </Text>
      <View
        accessible
        accessibilityLabel={`Track grip by session against ${base}: ${summary}.`}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onResponderGrant={touch}
        onResponderMove={touch}
        {...hover}>
        {width > 0 && (
          <Svg width={width} height={C.height} pointerEvents="none">
            {ticks.map((v) => (
              <Line key={`g${v}`} x1={C.left} x2={C.left + w} y1={y(v)} y2={y(v)} stroke={ink}
                strokeOpacity={v === 0 ? 0.35 : 0.08} strokeWidth={v === 0 ? 1.5 : 1} />
            ))}
            {ticks.map((v) => (
              <SvgText fontFamily={SVG_FONT} key={`t${v}`} x={C.left - 6} y={y(v) + 4} fontSize={10} fill={MUTED}
                textAnchor="end">
                {v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`}
              </SvgText>
            ))}
            <SvgText fontFamily={SVG_FONT} x={12} y={C.top + h / 2} fontSize={10} fill={MUTED} textAnchor="middle"
              transform={`rotate(-90 12 ${C.top + h / 2})`}>
              % grip
            </SvgText>
            {days > 1 && sessions.map((s, i) => newDay[i] && (
              <SvgText fontFamily={SVG_FONT} key={`d${i}`} x={x(i) - col / 2 + 4} y={12} fontSize={10} fill={MUTED}>
                {dayLabel(s.start)}
              </SvgText>
            ))}
            {days > 1 && sessions.map((_, i) => i > 0 && newDay[i] && (
              <Line key={`s${i}`} x1={x(i) - col / 2} x2={x(i) - col / 2} y1={2} y2={C.top + h} stroke={ink}
                strokeOpacity={0.2} strokeDasharray="3 3" />
            ))}
            {picked != null && (
              <Line x1={x(picked)} x2={x(picked)} y1={C.top} y2={C.top + h} stroke={ink} strokeOpacity={0.07}
                strokeWidth={col} />
            )}
            <Polyline points={sessions.map((s, i) => `${x(i)},${y(s.track)}`).join(' ')} fill="none" stroke={accent}
              strokeWidth={2} strokeOpacity={0.55} strokeLinejoin="round" />
            {sessions.map((s, i) => s.range && (
              <Line key={`r${i}`} x1={x(i)} x2={x(i)} y1={y(s.range[0])} y2={y(s.range[1])}
                stroke={s.wet ? MUTED : accent} strokeWidth={2} strokeLinecap="round" />
            ))}
            {sessions.map((s, i) => (
              <Circle key={`c${i}`} cx={x(i)} cy={y(s.track)} r={picked === i ? 6.5 : 5}
                fill={s.pm == null ? surface : s.wet ? MUTED : accent} stroke={s.pm == null ? accent : surface}
                strokeWidth={2} />
            ))}
            {sessions.map((s, i) => s.wet && (
              <SvgText fontFamily={SVG_FONT} key={`w${i}`} x={x(i)} y={y(s.range ? s.range[1] : s.track) - 8}
                fontSize={10} fill={ink} fillOpacity={0.7} textAnchor="middle">
                wet
              </SvgText>
            ))}
            {sessions.map((s, i) => i % every === 0 && (
              <SvgText fontFamily={SVG_FONT} key={`n${i}`} x={x(i)} y={C.top + h + 14} fontSize={10} fill={ink}
                fillOpacity={0.75} textAnchor="middle">
                {s.name}
              </SvgText>
            ))}
            {withAir && sessions.map((s, i) => i % every === 0 && s.ambient_c != null && (
              <SvgText fontFamily={SVG_FONT} key={`a${i}`} x={x(i)} y={C.top + h + 28} fontSize={10} fill={MUTED}
                textAnchor="middle">
                {`${Math.round(s.ambient_c)}°`}
              </SvgText>
            ))}
            {withAir && (
              <SvgText fontFamily={SVG_FONT} x={C.left - 6} y={C.top + h + 28} fontSize={10} fill={MUTED} textAnchor="end">
                air
              </SvgText>
            )}
          </Svg>
        )}
      </View>
      <Text style={styles.legend}>
        Dots: the median of each session&apos;s quick laps; bars: its 90 % range (a hollow dot had too few quick laps
        for one).
      </Text>
      <Pressable onPress={() => setAsTable(!asTable)} accessibilityRole="button">
        <Text style={styles.toggle}>{asTable ? 'Hide the table' : 'Show the sessions as a table'}</Text>
      </Pressable>
      {asTable && <SessionsTable sessions={sessions} />}
    </View>
  );
}

function readout(s: GripSession, base: string) {
  const when = [dayLabel(s.start), clock(s.start)].filter(Boolean).join(' ');
  const parts = [
    `${s.name} (${KIND[s.kind] ?? s.kind}${when ? `, ${when}` : ''})`,
    s.base ? `the base: 0 %` : `track ${pct(s.track)}${s.pm != null ? ` ± ${pct(s.pm, false)}` : ''} on ${base}`,
  ];
  if (s.measured != null && s.tyres != null && Math.abs(s.tyres) >= 0.1)
    parts.push(`measured ${pct(s.measured)}, tyres ${pct(s.tyres)}`);
  if (s.laps != null) parts.push(`${s.laps} quick lap${s.laps === 1 ? '' : 's'}${s.best ? `, best ${formatLap(s.best)}` : ''}`);
  const temps = [s.ambient_c != null ? `air ${Math.round(s.ambient_c)} °C` : null,
    s.track_c != null ? `track ${Math.round(s.track_c)} °C` : null].filter(Boolean);
  if (temps.length) parts.push(temps.join(', '));
  if (s.wet) parts.push('wiper on');
  return parts.join(' · ');
}

function SessionsTable({ sessions }: { sessions: GripSession[] }) {
  const cols: [string, number][] = [['Session', 120], ['Start', 96], ['Laps', 44], ['Track', 64], ['±', 50],
    ['Measured', 72], ['Tyres', 56], ['Air °C', 54], ['Track °C', 64]];
  const cell = (i: number, text: string, left = false) => (
    <Text key={i} numberOfLines={1}
      style={StyleSheet.flatten([styles.tCell, left && styles.tLeft, { width: cols[i][1] }])}>
      {text}
    </Text>
  );
  return (
    <ScrollView horizontal>
      <View>
        <View style={styles.tRow}>
          {cols.map(([c, wd], i) => (
            <Text key={c} style={StyleSheet.flatten([styles.tHead, i < 2 && styles.tLeft, { width: wd }])}>{c}</Text>
          ))}
        </View>
        {sessions.map((s) => (
          <View key={s.key ?? s.name} style={styles.tRow}>
            {cell(0, `${s.name}${s.wet ? ' (wet)' : ''}`, true)}
            {cell(1, [dayLabel(s.start), clock(s.start)].filter(Boolean).join(' '), true)}
            {cell(2, s.laps != null ? String(s.laps) : '–')}
            {cell(3, pct(s.track))}
            {cell(4, s.pm != null ? pct(s.pm, false) : '–')}
            {cell(5, pct(s.measured))}
            {cell(6, pct(s.tyres))}
            {cell(7, s.ambient_c != null ? s.ambient_c.toFixed(0) : '–')}
            {cell(8, s.track_c != null ? s.track_c.toFixed(0) : '–')}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  h2: { fontSize: 20, fontWeight: '700' },
  loading: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  error: { color: '#c8372d' },
  dim: { opacity: 0.6, fontSize: 13, lineHeight: 18 },
  callout: { borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 4 },
  calloutText: { fontSize: 16, lineHeight: 23 },
  para: { lineHeight: 20 },
  method: { gap: 6 },
  chart: { gap: 4, maxWidth: 760 },
  chartTitle: { fontSize: 13, fontWeight: '600' },
  readout: { fontSize: 13, minHeight: 36, fontVariant: ['tabular-nums'] },
  legend: { fontSize: 12, opacity: 0.6, lineHeight: 17 },
  toggle: { fontSize: 13, fontWeight: '600', opacity: 0.75, paddingVertical: 4 },
  tRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#8882', paddingVertical: 3 },
  tHead: { fontSize: 12, fontWeight: '600', opacity: 0.65, textAlign: 'right', paddingRight: 8 },
  tCell: { fontSize: 13, fontVariant: ['tabular-nums'], textAlign: 'right', paddingRight: 8 },
  tLeft: { textAlign: 'left' },
});
