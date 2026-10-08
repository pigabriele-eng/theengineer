// Runs of one event side by side (GET /events/{key}/compare): lap times, consistency, the best time in each section
// on the official corner numbers, top speed, tyres and conditions, in one table with a column per run. Each run wears
// the colour slot it was picked with (the validated lap palette), so the colours here match Compare laps. The best of
// each row is a purple block; the others print their gap to it in red, with a bar in the time-lost ramp in a section.
// Each run's tyres are under its name, one tap to change them (components/TyreTag.tsx): the four levels open above the
// table.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet } from 'react-native';

import { useLapColors } from '@/components/CompareViews';
import { Note } from '@/components/Controls';
import { Swatch, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { TyreChoices, TyreTag, TyreTags, useTyreTags } from '@/components/TyreTag';
import { DETECTED_CORNERS_NOTE, formatLap } from '@/lib/api';
import { encodePicks } from '@/lib/compare';
import { ComparedSession, dayLabel, eventsApi, KIND_NAMES, SideBySide } from '@/lib/events';
import { poll } from '@/lib/poll';
import { deltaMark, face, Fonts, themed, Type, useTheme } from '@/constants/Theme';

const COL_MIN = 104; // a run's column: as wide as the space allows, within these
const COL_MAX = 172;
const WHEELS = ['fl', 'fr', 'rl', 'rr'] as const;

export type Pick = { id: number; slot: number };

type Row = {
  label: string;
  values: (string | null)[];
  best?: number | null; // index of the best: a purple block
  gaps?: (number | null)[]; // the share of the biggest gap behind the best, drawn as a bar
  subs?: (string | null)[]; // a smaller line under the value: the gap to the best
  hint?: string;
};

/** A run's colour key: a short flat stroke, beside its name wherever it is written. */
export function RunKey({ color }: { color: string }) {
  return <View style={{ width: 16, height: 4, backgroundColor: color }} />;
}

export function EventCompare({ folderKey, picks, onClear }: {
  folderKey: string;
  picks: Pick[];
  onClear?: () => void;
}) {
  const styles = useStyles();
  const [data, setData] = useState<SideBySide | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = picks.map((p) => p.id);
  const key = ids.join(',');
  const colors = useLapColors(picks.map((p) => p.slot));
  const ask = useRef(0);
  // the event's tyres (shared with its runs' rows), their four levels opened from a column's tag
  const tags = useTyreTags(Number.isInteger(Number(folderKey)) ? Number(folderKey) : null);

  // ask once the picks settle; while the report is still reading logs, ask again (lib/poll.ts: less and less often)
  useEffect(() => {
    const id = ++ask.current;
    if (ids.length < 2) return;
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => {
      stop = poll(async (live) => {
        setBusy(true);
        try {
          const d = await eventsApi.compare(folderKey, ids);
          if (!live() || id !== ask.current) return false;
          setData(d);
          setError(null);
          return d.status === 'working';
        } catch (e) {
          if (id === ask.current) setError((e as Error).message);
          return false;
        } finally {
          if (id === ask.current) setBusy(false);
        }
      });
    }, 150);
    return () => {
      ask.current++;
      clearTimeout(timer);
      stop?.();
    };
  }, [folderKey, key]); // eslint-disable-line react-hooks/exhaustive-deps -- the ids, by value

  const shown = data && data.sessions.map((s) => s.id).join(',') === key ? data : null;
  if (ids.length < 2) return null;

  return (
    <View style={styles.box}>
      <View style={styles.topLine}>
        {busy && <ActivityIndicator size="small" />}
        {!shown && !error && <Note>Putting the runs side by side…</Note>}
        {onClear && <View style={styles.clear}><TextLink onPress={onClear} label="Clear" small /></View>}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      {shown && tags.open != null && (
        <TyreChoices tags={tags} id={tags.open} name={shown.sessions.find((s) => s.id === tags.open)?.name ?? ''} />
      )}
      {shown && <Table data={shown} colors={colors.laps} tags={tags} />}
      {shown?.status === 'working' && (
        <Note>
          Section times follow once the logs are read for the report
          {shown.progress?.current ? `: ${shown.progress.current}` : ''}.
        </Note>
      )}
      {shown && <CompareLapsLink sessions={shown.sessions} />}
    </View>
  );
}

/** One tap to Compare laps with each run's best lap, in the same colours. */
function CompareLapsLink({ sessions }: { sessions: ComparedSession[] }) {
  const laps = sessions.filter((s) => s.best_lap != null).map((s) => ({ session_id: s.id, lap: s.best_lap! }));
  if (laps.length < 2) return null;
  return (
    <TextLink href={{ pathname: '/compare', params: { laps: encodePicks(laps.slice(0, 6)) } }} red arrow
      label="Compare these best laps: traces and where the time is" />
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

/** Lap times: every time, the quickest on a purple block and the others with their gap to it underneath. */
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

function Table({ data, colors, tags }: { data: SideBySide; colors: string[]; tags: TyreTags }) {
  const c = useTheme();
  const styles = useStyles();
  const wide = useWide();
  const groups = rowsOf(data);
  const labelW = wide ? 150 : 104;
  const [width, setWidth] = useState(0);
  const colW = Math.round(Math.min(COL_MAX, Math.max(COL_MIN, (width - labelW) / data.sessions.length)));
  const col = { width: colW };
  const label = { width: labelW };
  return (
    <View style={styles.tableBox} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          <View style={styles.headRow}>
            <View style={label} />
            {data.sessions.map((s, i) => (
              <View key={s.id} style={StyleSheet.flatten([styles.col, col, styles.headCell])}>
                <RunKey color={colors[i]} />
                <Text style={styles.colName} numberOfLines={2}>{s.name}</Text>
                <Text style={styles.colSub} numberOfLines={1}>
                  {[s.date ? dayLabel(s.date) : null, s.time].filter(Boolean).join(' · ')}
                </Text>
                <Text style={styles.colSub} numberOfLines={1}>{KIND_NAMES[s.kind]}</Text>
                <TyreTag tags={tags} id={s.id} run={s.name} size={15} />
              </View>
            ))}
          </View>
          {groups.map((g) => (
            <View key={g.title}>
              <View style={styles.group}>
                <Text style={styles.groupTitle}>{g.title}</Text>
                {g.note && <Text style={styles.groupNote}>{g.note}</Text>}
              </View>
              {g.rows.map((r) => (
                <View key={r.label} style={styles.row}>
                  <View style={StyleSheet.flatten([styles.label, label])}>
                    <Text style={styles.rowName}>{r.label}</Text>
                    {r.hint && <Text style={styles.hint}>{r.hint}</Text>}
                  </View>
                  {r.values.map((v, i) => {
                    const best = r.best === i && r.values.filter((x) => x != null).length > 1;
                    const gap = r.gaps?.[i];
                    return (
                      <View key={i} style={StyleSheet.flatten([styles.col, col, styles.cell])}>
                        <View style={best ? { backgroundColor: c.timing.best } : undefined}>
                          <Text style={StyleSheet.flatten([styles.value, best && styles.best, v == null && styles.dim,
                            !best && gap != null && gap > 0 && { color: c.delta.loss }])}>
                            {v ?? '–'}
                          </Text>
                        </View>
                        {r.subs?.[i] && <Text style={styles.lost}>{r.subs[i]}</Text>}
                        {gap != null && gap > 0 && (
                          <View style={{ height: 5, width: Math.max(3, Math.min(1, gap) * (colW - 16)),
                            backgroundColor: deltaMark(c, gap, 1) }} />
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
      <View style={styles.legend}>
        <Swatch color={c.timing.best} label="Best of these runs" />
        <Swatch color={c.timing.loss[2]} height={5} label="Time lost to it" />
      </View>
      {data.sessions.filter((s) => s.note).map((s) => (
        <Note key={s.id}>{s.name}: {s.note}</Note>
      ))}
      {data.reference && (
        <Note>
          Sections are the report&apos;s, on the official corner numbers, placed on the line of the event&apos;s quickest
          lap. In a section the bars grow and deepen with the time lost.
        </Note>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { gap: 14 },
  topLine: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 18 },
  clear: { marginLeft: 'auto' },
  error: { fontFamily: Fonts.body, fontSize: 16, color: c.error },
  tableBox: { gap: 12 },
  headRow: { flexDirection: 'row', borderTopWidth: 3, borderBottomWidth: 1, borderColor: c.rule },
  headCell: { paddingTop: 8, paddingBottom: 7, gap: 3 },
  col: { paddingHorizontal: 6 },
  colName: { fontFamily: Fonts.display, fontSize: 16, lineHeight: 19, textTransform: 'uppercase', color: c.text },
  colSub: { fontFamily: face('label', 400), fontSize: 12, color: c.textSecondary },
  group: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 12, paddingTop: 16, paddingBottom: 5,
    borderBottomWidth: 3, borderColor: c.rule },
  groupTitle: { fontFamily: Fonts.display, fontSize: 20, lineHeight: 22, textTransform: 'uppercase', color: c.text },
  groupNote: { fontFamily: Type.dek.fontFamily, fontSize: 13, color: c.textSecondary },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderColor: c.separator },
  label: { paddingVertical: 7, paddingRight: 8 },
  rowName: { ...Type.label, fontFamily: Fonts.label, fontSize: 12, letterSpacing: 1.1, color: c.text },
  hint: { fontFamily: face('label', 400), fontSize: 11, color: c.textMuted, marginTop: 1 },
  cell: { paddingVertical: 6, gap: 3, alignItems: 'flex-start' },
  value: { fontFamily: Fonts.label, fontSize: 15, lineHeight: 19, fontVariant: ['tabular-nums'], color: c.text,
    paddingHorizontal: 4, paddingVertical: 1 },
  best: { fontFamily: Type.label.fontFamily, color: c.timing.onBest },
  dim: { color: c.textMuted },
  lost: { fontFamily: Fonts.label, fontSize: 12, fontVariant: ['tabular-nums'], color: c.delta.loss, paddingHorizontal: 4 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 8, alignItems: 'center' },
}));
