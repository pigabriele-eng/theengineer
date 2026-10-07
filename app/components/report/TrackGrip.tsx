import { useCallback, useEffect, useId, useState } from 'react';
import {
  ActivityIndicator,
  LayoutChangeEvent,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';

import { Fig, TextLink, useWide } from '@/components/Programme';
import { Text, useThemeColor } from '@/components/Themed';
import { useSeriesColors } from '@/components/TraceChart';
import { ResetZoom, useZoom, ZoomArea } from '@/components/Zoom';
import { formatLap } from '@/lib/api';
import { poll } from '@/lib/poll';
import { fetchTrackGrip, GripSession, pct, TrackGripAnswer, TrackGripResult } from '@/lib/trackGrip';
import { isZoomed, pixelOf, Range, shownRange, valueAt } from '@/lib/zoom';
import { chartPlate, Fonts, themed, Type, useTheme } from '@/constants/Theme';

const C = { left: 44, right: 12, top: 22, bottom: 44, height: 230 };
const CHAR_W = 7.2; // rough width of one character at fontSize 12
// SVG text takes the browser's default (serif) face on web: give it the system sans the rest of the app uses
const SVG_FONT = Fonts.sans;
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
// bare: inside a report section that already names it and says what it shows
export function TrackGrip({ event, bare }: { event: number; bare?: boolean }) {
  const styles = useStyles();
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

  // asked again while the server waits for what it needs (lib/poll.ts: less and less often)
  useEffect(() => {
    setBusy(true);
    setAnswer(null);
    return poll(async (live) => (await load()) && live());
  }, [load]);

  const result = answer?.result;
  return (
    <View style={styles.wrap}>
      {!bare && <Text style={styles.h2}>Track grip</Text>}
      {!bare && (
        <Text style={styles.dim}>
          Grip at the limit session by session{answer ? ` (${answer.car.label})` : ''}, with the tyres&apos; state taken
          out: the rest is the track rubbering in, its temperature and the weather.
        </Text>
      )}
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
      {result && result.available && <Body result={result} bare={bare} />}
    </View>
  );
}

export default TrackGrip;

function Body({ result, bare }: { result: TrackGripResult; bare?: boolean }) {
  const styles = useStyles();
  const tint = useThemeColor({}, 'tint');
  const wide = useWide();
  const c = useTheme();
  const [first, ...rest] = result.read;
  const h = result.headline;
  // in the report: the change as a very large figure beside the chart, the first read under it
  if (bare && h) {
    const up = h.change_pct >= 0;
    const tone = Math.abs(h.change_pct) < 0.5 ? c.text : up ? c.delta.gain : c.delta.loss;
    return (
      <>
        <View style={wide ? styles.tg : styles.tgPhone}>
          <View style={wide ? styles.tgLead : undefined}>
            <Fig label={`Grip ${up ? 'rose' : 'fell'} about`} value={`${up ? '+' : '−'}${Math.abs(h.change_pct).toFixed(0)}`}
              unit="%" size={wide ? 132 : 104} color={tone} bar={tone} />
            {h.pm != null && <Text style={styles.pm}>± {h.pm.toFixed(1)} %</Text>}
            {first && <Text style={styles.leadText}>{first}</Text>}
          </View>
          <View style={styles.tgChart}>
            <GripChart sessions={result.sessions} base={result.base ?? result.sessions[0]?.name ?? ''} />
          </View>
        </View>
        {rest.map((r) => <Text key={r} style={styles.para}>{r}</Text>)}
        {result.notes.map((n) => <Text key={n} style={styles.dim}>{n}</Text>)}
        <Method result={result} />
      </>
    );
  }
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
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const b = result.basis;
  return (
    <View style={styles.method}>
      <TextLink label={open ? 'Hide how this is worked out' : 'How this is worked out'} small onPress={() => setOpen(!open)} />
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
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const ink = useThemeColor({}, 'text');
  const surface = useThemeColor({}, 'surface');
  const MUTED = useTheme().chart.muted; // de-emphasis grey of the chart palette
  const accent = useSeriesColors().reference;
  const zoom = useZoom();
  const clip = `clip${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const n = sessions.length;
  if (!n) return null;

  // zoomed along the sessions (each a column a unit wide), the grip scale fits the sessions shown
  const full: Range = [-0.5, n - 0.5];
  const view = shownRange(zoom.view, full, 2);
  const zoomed = isZoomed(view, full);
  const shown = sessions.filter((_, i) => i >= view[0] && i <= view[1]);
  const vals = (shown.length ? shown : sessions).flatMap((s) => [s.track, ...(s.range ?? [])]).concat([0]);
  const step = niceStep(Math.max(...vals) - Math.min(...vals) || 1);
  const lo = Math.floor((Math.min(...vals) - step / 4) / step) * step;
  const hi = Math.ceil((Math.max(...vals) + step / 4) / step) * step;
  const w = Math.max(width - C.left - C.right, 1);
  const h = C.height - C.top - C.bottom;
  const col = w / (view[1] - view[0]);
  const x = (i: number) => pixelOf(i, view, C.left, w);
  const y = (v: number) => C.top + (1 - (v - lo) / (hi - lo)) * h;
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
  const longest = Math.max(...sessions.map((s) => s.name.length)) * CHAR_W + 6;
  const every = Math.max(1, Math.ceil(longest / Math.max(col, 1)));
  const newDay = sessions.map((s, i) => i === 0 || day(s.start) !== day(sessions[i - 1].start));
  const days = new Set(sessions.map((s) => day(s.start))).size;
  const withAir = sessions.some((s) => s.ambient_c != null);

  const nearest = (px: number) => {
    if (px < C.left || px > C.left + w) return null;
    const i = Math.round(valueAt(px, view, C.left, w));
    return i >= 0 && i < n ? i : null;
  };
  const p = picked != null ? sessions[picked] : null;
  const summary = sessions.map((s) => `${s.name} ${pct(s.track)}`).join(', ');

  return (
    <View style={styles.chart}>
      <View style={styles.head}>
        <Text style={styles.chartTitle}>{title ?? `Track grip by session, % against ${base}`}</Text>
        <ResetZoom zoom={zoom} reserve />
      </View>
      <Text style={styles.readout} numberOfLines={3}>
        {p ? readout(p, base)
          : Platform.OS === 'web' ? 'Point at a session for its numbers.' : 'Touch a session for its numbers.'}
      </Text>
      <ZoomArea zoom={zoom} full={full} left={C.left} width={w} minSpan={2} onCursor={(px) => setPicked(nearest(px))}
        onLeave={() => setPicked(null)} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && (
          <Svg width={width} height={C.height} pointerEvents="none"
            accessibilityLabel={`Track grip by session against ${base}: ${summary}.`}>
            {zoomed && (
              <Defs>
                <ClipPath id={clip}>
                  <Rect x={C.left} y={0} width={w} height={C.height} />
                </ClipPath>
              </Defs>
            )}
            {ticks.map((v) => (
              <Line key={`g${v}`} x1={C.left} x2={C.left + w} y1={y(v)} y2={y(v)} stroke={ink}
                strokeOpacity={v === 0 ? 0.35 : 0.08} strokeWidth={v === 0 ? 1.5 : 1} />
            ))}
            {ticks.map((v) => (
              <SvgText fontFamily={SVG_FONT} key={`t${v}`} x={C.left - 6} y={y(v) + 4} fontSize={12} fill={MUTED}
                textAnchor="end">
                {v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`}
              </SvgText>
            ))}
            <SvgText fontFamily={SVG_FONT} x={12} y={C.top + h / 2} fontSize={12} fill={MUTED} textAnchor="middle"
              transform={`rotate(-90 12 ${C.top + h / 2})`}>
              % grip
            </SvgText>
            <G clipPath={zoomed ? `url(#${clip})` : undefined}>
              {days > 1 && sessions.map((s, i) => newDay[i] && (
                <SvgText fontFamily={SVG_FONT} key={`d${i}`} x={x(i) - col / 2 + 4} y={12} fontSize={12} fill={MUTED}>
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
                  fontSize={12} fill={ink} fillOpacity={0.7} textAnchor="middle">
                  wet
                </SvgText>
              ))}
              {sessions.map((s, i) => i % every === 0 && (
                <SvgText fontFamily={SVG_FONT} key={`n${i}`} x={x(i)} y={C.top + h + 14} fontSize={12} fill={ink}
                  fillOpacity={0.75} textAnchor="middle">
                  {s.name}
                </SvgText>
              ))}
              {withAir && sessions.map((s, i) => i % every === 0 && s.ambient_c != null && (
                <SvgText fontFamily={SVG_FONT} key={`a${i}`} x={x(i)} y={C.top + h + 28} fontSize={12} fill={MUTED}
                  textAnchor="middle">
                  {`${Math.round(s.ambient_c)}°`}
                </SvgText>
              ))}
            </G>
            {withAir && (
              <SvgText fontFamily={SVG_FONT} x={C.left - 6} y={C.top + h + 28} fontSize={12} fill={MUTED} textAnchor="end">
                air
              </SvgText>
            )}
          </Svg>
        )}
      </ZoomArea>
      <Text style={styles.legend}>
        Dots: the median of each session&apos;s quick laps; bars: its 90 % range (a hollow dot had too few quick laps
        for one).
      </Text>
      <TextLink label={asTable ? 'Hide the table' : 'Show the sessions as a table'} small onPress={() => setAsTable(!asTable)} />
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
  const styles = useStyles();
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

const useStyles = themed((c) => ({
  wrap: { gap: 10 },
  h2: { fontSize: 20, fontWeight: '700' },
  loading: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  error: { color: c.error },
  dim: { fontFamily: Fonts.label, fontSize: 12, lineHeight: 16, color: c.textMuted },
  tg: { flexDirection: 'row', gap: 32 },
  tgPhone: { flexDirection: 'column', gap: 16 },
  tgLead: { width: 300 },
  tgChart: { flex: 1, minWidth: 0 },
  pm: { fontFamily: Fonts.display, fontSize: 34, lineHeight: 38, marginTop: 12, color: c.text },
  leadText: { fontFamily: Fonts.body, fontSize: 18, lineHeight: 25, marginTop: 12, color: c.text },
  callout: { borderLeftWidth: 10, paddingLeft: 16, paddingVertical: 4 },
  calloutText: { fontFamily: Fonts.body, fontSize: 18, lineHeight: 25, color: c.text },
  para: { lineHeight: 20 },
  method: { gap: 6 },
  chart: { gap: 4, maxWidth: 760, ...chartPlate(c) },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  chartTitle: { ...Type.label, color: c.text, flexShrink: 1 },
  readout: { fontSize: 13, minHeight: 36, fontVariant: ['tabular-nums'] },
  legend: { fontSize: 12, opacity: 0.6, lineHeight: 17 },
  tRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 3 },
  tHead: { ...Type.label, fontSize: 11, color: c.textSecondary, textAlign: 'right', paddingRight: 8 },
  tCell: { fontSize: 13, fontVariant: ['tabular-nums'], textAlign: 'right', paddingRight: 8 },
  tLeft: { textAlign: 'left' },
}));
