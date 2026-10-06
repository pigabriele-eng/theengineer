// Sessions of one event side by side (GET /events/{key}/compare): lap times, consistency, the best time in each section
// on the official corner numbers, top speed, tyres and conditions, in one table with a column per session. Each
// session wears the colour slot it was picked with (the validated lap palette), so the colours here match Compare laps.
import { Link } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { LineKey, useLapColors } from '@/components/CompareViews';
import { Text, View, useThemeColor } from '@/components/Themed';
import { DETECTED_CORNERS_NOTE, formatLap } from '@/lib/api';
import { encodePicks } from '@/lib/compare';
import { ComparedSession, dayLabel, eventsApi, KIND_NAMES, SideBySide } from '@/lib/events';
import { Radius, themed, useTheme } from '@/constants/Theme';

const POLL_MS = 3000;
const LABEL_W = 112;
const COL_MIN = 100; // a session's column: as wide as the space allows, within these
const COL_MAX = 168;
const WHEELS = ['fl', 'fr', 'rl', 'rr'] as const;

export type Pick = { id: number; slot: number };

type Row = {
  label: string;
  values: (string | null)[];
  best?: number | null; // index in bold
  gaps?: (number | null)[]; // seconds behind the best, drawn as a bar in the session's colour
  subs?: (string | null)[]; // a smaller line under the value
  hint?: string;
};

export function EventCompare({ folderKey, picks, onClear }: {
  folderKey: string;
  picks: Pick[];
  onClear?: () => void;
}) {
  const styles = useStyles();
  const [data, setData] = useState<SideBySide | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tint = useThemeColor({}, 'tint');
  const ids = picks.map((p) => p.id);
  const key = ids.join(',');
  const colors = useLapColors(picks.map((p) => p.slot));
  const ask = useRef(0);

  // ask once the picks settle; while the report is still reading logs, ask again every few seconds
  useEffect(() => {
    const id = ++ask.current;
    if (ids.length < 2) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      setBusy(true);
      try {
        const d = await eventsApi.compare(folderKey, ids);
        if (id !== ask.current) return;
        setData(d);
        setError(null);
        if (d.status === 'working') timer = setTimeout(run, POLL_MS);
      } catch (e) {
        if (id === ask.current) setError((e as Error).message);
      } finally {
        if (id === ask.current) setBusy(false);
      }
    };
    timer = setTimeout(run, 150);
    return () => {
      ask.current++;
      if (timer) clearTimeout(timer);
    };
  }, [folderKey, key]); // eslint-disable-line react-hooks/exhaustive-deps -- the ids, by value

  const shown = data && data.sessions.map((s) => s.id).join(',') === key ? data : null;
  if (ids.length < 2) return null;

  return (
    <View style={styles.box}>
      <View style={styles.titleRow}>
        <Text style={styles.h2}>Side by side</Text>
        {busy && <ActivityIndicator size="small" />}
        {onClear && (
          <Pressable onPress={onClear} hitSlop={8} accessibilityRole="button" style={styles.clear}>
            <Text style={{ color: tint }}>Clear</Text>
          </Pressable>
        )}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      {!shown && !error && <Text style={styles.note}>Putting the sessions side by side…</Text>}
      {shown && <Table data={shown} colors={colors.laps} />}
      {shown?.status === 'working' && (
        <Text style={styles.note}>
          Section times follow once the logs are read for the report
          {shown.progress?.current ? `: ${shown.progress.current}` : ''}.
        </Text>
      )}
      {shown && <CompareLapsLink sessions={shown.sessions} />}
    </View>
  );
}

/** One tap to Compare laps with each session's best lap, in the same colours. */
function CompareLapsLink({ sessions }: { sessions: ComparedSession[] }) {
  const styles = useStyles();
  const tint = useThemeColor({}, 'tint');
  const laps = sessions.filter((s) => s.best_lap != null).map((s) => ({ session_id: s.id, lap: s.best_lap! }));
  if (laps.length < 2) return null;
  return (
    // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
    <Link href={{ pathname: '/compare', params: { laps: encodePicks(laps.slice(0, 6)) } }} asChild>
      <Pressable style={StyleSheet.flatten([styles.button, { borderColor: tint }])} accessibilityRole="link">
        <Text style={StyleSheet.flatten([styles.buttonText, { color: tint }])}>
          Compare these best laps: traces and where the time is ›
        </Text>
      </Pressable>
    </Link>
  );
}

const secs = (v: number | null | undefined, digits = 3) => (v == null ? null : v.toFixed(digits));
const gapText = (v: number, best: number, digits = 2) => `+${(v - best).toFixed(digits)}`;

function minIndex(values: (number | null | undefined)[], higher = false) {
  let at: number | null = null;
  values.forEach((v, i) => {
    if (v == null) return;
    if (at == null || (higher ? v > values[at]! : v < values[at]!)) at = i;
  });
  return at;
}

/** Lap times: every time, the quickest in bold and the others with their gap to it underneath. */
function timeRow(label: string, values: (number | null)[], hint?: string): Row {
  const best = minIndex(values);
  const b = best != null ? values[best]! : null;
  return {
    label, hint, best,
    values: values.map((v) => (v == null ? null : formatLap(v))),
    subs: values.map((v, i) => (v == null || b == null || i === best ? null : gapText(v, b))),
  };
}

function rowsOf(data: SideBySide): { title: string; rows: Row[]; note?: string }[] {
  const ss = data.sessions;
  const lapRows: Row[] = [
    timeRow('Best lap', ss.map((s) => s.best_lap_s)),
    timeRow('Typical lap', ss.map((s) => s.typical_s), 'median clean lap'),
    timeRow('Best sections', ss.map((s) => s.ideal_s), 'added up'),
    { label: 'Clean laps', values: ss.map((s) => `${s.clean_laps} of ${s.laps}`) },
    { label: 'Consistency', values: ss.map((s) => (s.consistency != null ? `${s.consistency.toFixed(0)}/100` : null)),
      best: minIndex(ss.map((s) => s.consistency), true), hint: '100: every lap as quick as the best' },
    { label: 'Top speed', values: ss.map((s) => (s.top_speed_kmh != null ? `${s.top_speed_kmh.toFixed(1)} km/h` : null)),
      best: minIndex(ss.map((s) => s.top_speed_kmh), true) },
  ];
  const groups: { title: string; rows: Row[]; note?: string }[] = [{ title: 'Lap times', rows: lapRows }];

  if (data.sections.length) {
    const biggest = Math.max(0.05, ...data.sections.flatMap((sec) => sec.times.map((t) =>
      t != null && sec.best != null ? t - sec.times[sec.best]! : 0)));
    groups.push({
      title: 'Best time in each section',
      note: data.numbering === 'detected' ? DETECTED_CORNERS_NOTE : undefined,
      rows: data.sections.map((sec) => {
        const b = sec.best != null ? sec.times[sec.best]! : null;
        return {
          label: sec.code,
          best: sec.best,
          values: sec.times.map((t, i) => (t == null ? null : i === sec.best || b == null ? secs(t, 3) : gapText(t, b, 3))),
          gaps: sec.times.map((t) => (t == null || b == null ? null : (t - b) / biggest)),
        };
      }),
    });
  }

  const tyreRow = (label: string, kind: 'pressure' | 'temp', digits: number): Row | null => {
    if (!ss.some((s) => s.tyres[kind])) return null;
    const unit = ss.find((s) => s.tyre_units[kind])?.tyre_units[kind] ?? '';
    return {
      label: `${label}${unit ? ` (${unit === 'C' ? '°C' : unit})` : ''}`,
      hint: 'FL FR / RL RR',
      values: ss.map((s) => {
        const t = s.tyres[kind];
        if (!t) return null;
        const v = (w: (typeof WHEELS)[number]) => (t[w] != null ? t[w].toFixed(digits) : '–');
        return `${v('fl')} ${v('fr')}\n${v('rl')} ${v('rr')}`;
      }),
    };
  };
  const conditionLabels = [...new Set(ss.flatMap((s) => s.conditions.map((c) => c.label)))];
  const other = [
    tyreRow('Tyre pressure', 'pressure', 2),
    tyreRow('Tyre temp', 'temp', 0),
    ...conditionLabels.map((label): Row => ({
      label,
      values: ss.map((s) => {
        const c = s.conditions.find((x) => x.label === label);
        return c ? `${c.value.toFixed(1)} ${c.unit}` : null;
      }),
    })),
  ].filter((r): r is Row => r != null);
  if (other.length) groups.push({ title: 'Tyres and conditions', rows: other, note: 'Medians over the clean laps.' });
  return groups;
}

function Table({ data, colors }: { data: SideBySide; colors: string[] }) {
  const theme = useTheme();
  const styles = useStyles();
  const groups = rowsOf(data);
  const wash = theme.fill;
  const [width, setWidth] = useState(0);
  const colW = Math.round(Math.min(COL_MAX, Math.max(COL_MIN, (width - LABEL_W) / data.sessions.length)));
  const col = { width: colW };
  return (
    <View style={styles.tableBox} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          <View style={styles.row}>
            <View style={[styles.label, styles.headCell]} />
            {data.sessions.map((s, i) => (
              <View key={s.id} style={[styles.col, col, styles.headCell]}>
                <View style={styles.colHead}>
                  <LineKey color={colors[i]} />
                  <Text style={styles.colName} numberOfLines={2}>{s.name}</Text>
                </View>
                <Text style={styles.colSub} numberOfLines={1}>
                  {[s.date ? dayLabel(s.date) : null, s.time].filter(Boolean).join(' · ')}
                </Text>
                <Text style={styles.colSub} numberOfLines={1}>{KIND_NAMES[s.kind]}</Text>
              </View>
            ))}
          </View>
          {groups.map((g) => (
            <View key={g.title}>
              <Text style={styles.group}>{g.title}</Text>
              {g.note && <Text style={[styles.note, styles.groupNote]}>{g.note}</Text>}
              {g.rows.map((r) => (
                <View key={r.label} style={styles.row}>
                  <View style={styles.label}>
                    <Text style={styles.rowName}>{r.label}</Text>
                    {r.hint && <Text style={styles.hint}>{r.hint}</Text>}
                  </View>
                  {r.values.map((v, i) => {
                    const best = r.best === i && r.values.filter((x) => x != null).length > 1;
                    return (
                      <View key={i} style={StyleSheet.flatten([styles.col, col, styles.cell,
                        best && { backgroundColor: wash }])}>
                        <Text style={StyleSheet.flatten([styles.value, best && styles.best, v == null && styles.dim])}>
                          {v ?? '–'}
                        </Text>
                        {r.subs?.[i] && <Text style={styles.sub}>{r.subs[i]}</Text>}
                        {r.gaps && r.gaps[i] != null && r.gaps[i]! > 0 && (
                          <GapBar share={r.gaps[i]!} color={colors[i]} width={colW - 16} />
                        )}
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {data.sessions.filter((s) => s.note).map((s) => (
        <Text key={s.id} style={styles.note}>{s.name}: {s.note}</Text>
      ))}
      {data.reference && (
        <Text style={styles.note}>
          Bold: the quickest. In a section the others show the gap to it, and their bars scale with that gap. Sections are
          the report&apos;s, on the official corner numbers, placed on the line of the event&apos;s quickest lap.
        </Text>
      )}
    </View>
  );
}

/** The time a session loses in a section, as a bar from the left edge of its cell (4 px rounded end). */
function GapBar({ share, color, width }: { share: number; color: string; width: number }) {
  const styles = useStyles();
  const w = Math.max(3, Math.min(1, share) * width);
  const h = 4;
  const r = 2;
  return (
    <Svg width={width} height={h} style={styles.bar}>
      <Path d={`M0,0H${w - r}Q${w},0 ${w},${r}Q${w},${h} ${w - r},${h}H0Z`} fill={color} />
    </Svg>
  );
}

const useStyles = themed((c) => ({
  box: { gap: 10, backgroundColor: 'transparent' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'transparent' },
  h2: { fontSize: 18, fontWeight: '700' },
  clear: { marginLeft: 'auto' },
  error: { color: c.error },
  note: { fontSize: 12, opacity: 0.6 },
  tableBox: { gap: 6, backgroundColor: 'transparent' },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderColor: c.separator, backgroundColor: 'transparent' },
  headCell: { paddingBottom: 6 },
  label: { width: LABEL_W, paddingVertical: 6, paddingRight: 6, backgroundColor: 'transparent' },
  col: { paddingHorizontal: 8, backgroundColor: 'transparent' },
  cell: { paddingVertical: 6, gap: 4 },
  colHead: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'transparent' },
  colName: { fontSize: 14, fontWeight: '700', flexShrink: 1 },
  colSub: { fontSize: 11, opacity: 0.6 },
  sub: { fontSize: 12, opacity: 0.6, fontVariant: ['tabular-nums'] },
  group: { fontSize: 12, fontWeight: '700', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5,
    paddingTop: 14, paddingBottom: 4 },
  groupNote: { paddingBottom: 4 },
  rowName: { fontSize: 14, fontWeight: '600' },
  hint: { fontSize: 11, opacity: 0.55 },
  value: { fontSize: 14, fontVariant: ['tabular-nums'] },
  best: { fontWeight: '700' },
  dim: { opacity: 0.4 },
  bar: { marginTop: 1 },
  button: { borderWidth: 1, borderRadius: Radius.control, padding: 12, alignItems: 'center' },
  buttonText: { fontWeight: '600', fontSize: 15, textAlign: 'center' },
}));
