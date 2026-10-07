// One driver's habit tracker: their recurring technique mistakes over every event (lib/habits.ts), the answer first.
// Their costliest habit and whether it is getting better, then a teammate to set beside them, the areas of driving
// and the kinds of corner side by side, every habit with where it shows most and, on a tap, event by event, and how
// the two drive differently when they share the car. In the programme's chrome: thin ink rules under the heads,
// hairlines between rows, square bars, each driver's colour a flat square beside their code.
//
// A page can show one for each driver: they share one request (lib/habits.ts loadHabits), and poll again while the
// technique check is still at work.
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, ViewStyle } from 'react-native';

import { Dot } from '@/components/DriverTrends';
import { Notice, Tabs, useText } from '@/components/Picks';
import { Label, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { useSeriesColors } from '@/components/TraceChart';
import { Palette } from '@/constants/Colors';
import { face, Fonts, themed, Type, useTheme } from '@/constants/Theme';
import type { HabitEvent, HabitRow, HabitStat, HabitTracker as Habits, HabitTrend } from '@/lib/habits';
import { loadHabits, peekHabits } from '@/lib/habits';
import {
  barScale,
  checkingWords,
  cornerWords,
  habitsFor,
  headline,
  history,
  keepMate,
  pct,
  perLap,
  sharedEvents,
  styleDifferences,
  trendMark,
  trendSentence,
} from '@/lib/habitView';

const POLL_MS = 10_000;
const FRESH_MS = 5_000; // a poll takes an answer at most this old: trackers polling together share one request
const SHOWN = 8;

/** The habit tracker from the server, shared by every tracker on screen, asked again every 10 s while the technique
 * check is still at work. */
export function useHabits(): { data: Habits | null; error: string | null } {
  const [data, setData] = useState<Habits | null>(() => peekHabits());
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true); // false once the page is gone: an answer still on its way is dropped, not polled on

  const load = useCallback((maxAgeMs?: number) => {
    loadHabits(maxAgeMs).then(
      (d) => {
        if (!live.current) return;
        setData(d);
        setError(null);
        if (timer.current) clearTimeout(timer.current);
        if (d.status === 'checking') timer.current = setTimeout(() => load(FRESH_MS), POLL_MS);
      },
      (e) => live.current && setError((e as Error).message),
    );
  }, []);
  useEffect(() => {
    live.current = true;
    load();
    return () => {
      live.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);
  return { data, error };
}

/** A driver shown: their id, code and colour. */
type Col = { id: number; code: string; name: string; color: string };

/** One driver's habits, with a teammate beside them when there is one (the one they shared most events with, or the
 * one picked). */
export default function HabitTracker({ driverId }: { driverId: number }) {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const series = useSeriesColors();
  const { data, error } = useHabits();
  const [chosen, setChosen] = useState<number | null | undefined>(undefined); // undefined: the default teammate

  if (data == null) {
    return error ? <Text style={t.error}>{error}</Text> : <ActivityIndicator color={theme.text} style={styles.spin} />;
  }
  const busy = data.status === 'checking' ? (
    <Notice busy><Text style={t.note}>{checkingWords(data.checking)}</Text></Notice>
  ) : null;
  const me = data.drivers.find((d) => d.id === driverId);
  if (!me) {
    return (
      <View style={styles.tracker}>
        {busy}
        <Text style={t.note}>
          Their habits appear here once the technique check has run on events where they are named as the driver.
        </Text>
      </View>
    );
  }

  const mateId = keepMate(data.drivers, data.events, driverId, chosen);
  const mate = data.drivers.find((d) => d.id === mateId) ?? null;
  // each driver keeps a colour whoever is shown first (by their place in the list), and two shown never share one
  const own = (id: number) => (data.drivers.findIndex((d) => d.id === id) % 2 === 0 ? series.reference : series.compare);
  const myColor = own(me.id);
  const mateColor = mate && own(mate.id) !== myColor ? own(mate.id) : myColor === series.reference
    ? series.compare : series.reference;
  const cols: Col[] = [{ id: me.id, code: me.code, name: me.name, color: myColor }];
  if (mate) cols.push({ id: mate.id, code: mate.code, name: mate.name, color: mateColor });
  const others = data.drivers.filter((d) => d.id !== driverId);
  const diffs = mate ? styleDifferences(data.pairs, data.groups, cols[0], cols[1]) : null;

  return (
    <View style={styles.tracker}>
      {busy}
      {error && <Text style={t.error}>{error}</Text>}

      <Headline habits={data.habits} col={cols[0]} />

      {others.length > 0 && (
        <Tabs<number | null> label="Side by side with" value={mateId} onChange={setChosen}
          items={[
            ...others.map((d) => {
              const n = sharedEvents(data.events, driverId, d.id);
              return { key: d.id as number | null, label: d.name, swatch: d.id === mateId ? mateColor : undefined,
                sub: n > 0 ? `${n} event${n === 1 ? '' : 's'} together` : undefined };
            }),
            { key: null, label: 'Nobody' },
          ]} />
      )}

      <Part title="By area">
        <StatTable cols={cols} rows={data.groups.map((g) => ({ key: g.key, label: g.label, stats: g.drivers }))} />
      </Part>

      {data.corner_types.length > 0 && (
        <Part title="By corner type" note={data.corner_types_note}>
          <StatTable cols={cols}
            rows={data.corner_types.map((c) => ({ key: c.key, label: c.label, note: c.note, stats: c.drivers }))} />
        </Part>
      )}

      <Part title="Habits, costliest first">
        <HabitList habits={habitsFor(data.habits, driverId, mateId)} cols={cols} events={data.events} />
      </Part>

      {mate && diffs && (
        <Part title="Style differences"
          note={`Every time ${me.code} and ${mate.code} shared the car (${diffs.events} event${diffs.events === 1 ? '' : 's'}).`}>
          {diffs.groups.map((g) => (
            <View key={g.key}>
              <Label small muted>{g.label}</Label>
              {g.lines.map((l) => (
                <View key={l.kind} style={styles.row}>
                  <Text style={t.body}>{l.line}</Text>
                  <Text style={t.small}>{l.at}</Text>
                </View>
              ))}
            </View>
          ))}
        </Part>
      )}
    </View>
  );
}

/** A part of the tracker: a label over a thin ink rule, an optional line, then its content. */
function Part({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  const styles = useStyles();
  const t = useText();
  return (
    <View style={styles.part}>
      <Text style={t.sub} accessibilityRole="header">{title}</Text>
      {note ? <Text style={t.note}>{note}</Text> : null}
      {children}
    </View>
  );
}

/** The trend's colour: better in green, worse in the warning colour, the rest neutral. */
const trendColor = (c: Palette, trend: HabitTrend | null | undefined) =>
  trend?.dir === 'better' ? c.success : trend?.dir === 'worse' ? c.warning : trend ? c.textSecondary : c.textMuted;

/** The answer first: the driver's costliest habit, its figures and its trend. */
function Headline({ habits, col }: { habits: HabitRow[]; col: Col }) {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const h = headline(habits, col.id);
  return (
    <View style={styles.lead}>
      <Label small muted>Costliest habit</Label>
      <View style={styles.leadRow}>
        <View style={styles.who}>
          <Dot color={col.color} size={12} />
          <Text style={styles.code}>{col.code}</Text>
        </View>
        <View style={styles.flex}>
          <Text style={t.lead}>{h.text}</Text>
          {!h.none && (
            <Text style={StyleSheet.flatten([t.body, { color: trendColor(theme, h.trend) }])}>{trendSentence(h.trend)}</Text>
          )}
        </View>
      </View>
    </View>
  );
}

// ---------- areas and corner types: one row each, a column per driver ----------

type StatRowData = { key: string; label: string; note?: string; stats: Record<string, HabitStat> };

function StatTable({ cols, rows }: { cols: Col[]; rows: StatRowData[] }) {
  const styles = useStyles();
  const t = useText();
  const wide = useWide();
  const stacked = !wide && cols.length > 1; // on a phone two drivers sit under the row's name
  return (
    <View>
      {cols.length > 1 && (
        <View style={styles.tableHead}>
          {!stacked && <View style={styles.flex} />}
          {cols.map((c) => (
            <View key={c.id} style={StyleSheet.flatten([styles.headCell, stacked ? styles.flex : styles.cellWide])}>
              <Dot color={c.color} />
              <Text style={styles.th} numberOfLines={1}>{c.code}</Text>
            </View>
          ))}
        </View>
      )}
      {rows.map((r) => <StatRow key={r.key} row={r} cols={cols} stacked={stacked} />)}
      <Text style={StyleSheet.flatten([t.small, styles.after])}>Tap a row to see how it changed.</Text>
    </View>
  );
}

function StatRow({ row, cols, stacked }: { row: StatRowData; cols: Col[]; stacked: boolean }) {
  const styles = useStyles();
  const t = useText();
  const wide = useWide();
  const [open, setOpen] = useState(false);
  const name = (
    <View style={stacked ? null : styles.flex}>
      <Text style={styles.rowLabel}>{row.label}</Text>
      {row.note ? <Text style={t.small}>{row.note}</Text> : null}
    </View>
  );
  const cells = cols.map((c) => (
    <Cell key={c.id} stat={row.stats[String(c.id)]} open={open}
      style={stacked ? styles.flex : wide ? styles.cellWide : styles.cellPhone} />
  ));
  return (
    <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }}
      accessibilityHint="Shows how it changed" style={styles.row}>
      {stacked ? (
        <>
          {name}
          <View style={styles.cells}>{cells}</View>
        </>
      ) : (
        <View style={styles.line}>
          {name}
          {cells}
        </View>
      )}
    </Pressable>
  );
}

/** One driver's figures in a table: how often, what it costs a lap, the trend's word (its sentence when open). */
function Cell({ stat, open, style }: { stat: HabitStat | undefined; open: boolean; style: ViewStyle | null }) {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  if (!stat) {
    return <View style={style}><Text style={styles.none}>No laps</Text></View>;
  }
  const color = trendColor(theme, stat.trend);
  return (
    <View style={StyleSheet.flatten([styles.cell, style])}>
      <Text style={styles.rate}>{pct(stat.rate)}<Text style={styles.unit}> of corners</Text></Text>
      <Text style={styles.cost}>{perLap(stat.cost_per_lap_s)}</Text>
      <Text style={StyleSheet.flatten([styles.mark, { color }])}>{trendMark(stat.trend)}</Text>
      {open && <Text style={t.small}>{trendSentence(stat.trend)}</Text>}
    </View>
  );
}

// ---------- habits ----------

function HabitList({ habits, cols, events }: { habits: HabitRow[]; cols: Col[]; events: HabitEvent[] }) {
  const styles = useStyles();
  const t = useText();
  const [all, setAll] = useState(false);
  if (habits.length === 0) {
    return <Text style={t.note}>No repeated mistake found yet.</Text>;
  }
  return (
    <View>
      {(all ? habits : habits.slice(0, SHOWN)).map((h) => <HabitItem key={h.kind} habit={h} cols={cols} events={events} />)}
      {habits.length > SHOWN && (
        <View style={styles.after}>
          <TextLink small label={all ? 'Show fewer' : `Show all ${habits.length}`} onPress={() => setAll(!all)} />
        </View>
      )}
    </View>
  );
}

/** A habit: what it is and what to do instead, each driver's figures, trend and corners; tapped, event by event. */
function HabitItem({ habit, cols, events }: { habit: HabitRow; cols: Col[]; events: HabitEvent[] }) {
  const styles = useStyles();
  const t = useText();
  const wide = useWide();
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }}
      style={styles.row}>
      <Text style={styles.rowLabel}>{habit.label}</Text>
      <Text style={t.note}>{habit.do}</Text>
      <View style={wide ? styles.sides : styles.sidesPhone}>
        {cols.map((c) => <HabitSide key={c.id} habit={habit} col={c} events={events} />)}
      </View>
      {open && <History habit={habit} cols={cols} events={events} />}
      <Label small muted>{open ? 'Hide event by event' : 'Event by event'}</Label>
    </Pressable>
  );
}

function HabitSide({ habit, col, events }: { habit: HabitRow; col: Col; events: HabitEvent[] }) {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const wide = useWide();
  const s = habit.drivers[String(col.id)];
  const seen = s != null && s.rate > 0;
  const where = seen ? cornerWords(s.corners, events) : null;
  return (
    <View style={wide ? styles.side : styles.sidePhone}>
      <View style={styles.who}>
        <Dot color={col.color} />
        <Text style={styles.th}>{col.code}</Text>
        <Text style={seen ? styles.figs : styles.none}>
          {seen ? `${pct(s.rate)} of corners · ${perLap(s.cost_per_lap_s)}` : 'Not seen'}
        </Text>
      </View>
      {seen && <Text style={StyleSheet.flatten([t.small, { color: trendColor(theme, s.trend) }])}>{trendSentence(s.trend)}</Text>}
      {where && <Text style={t.small}>{where}</Text>}
    </View>
  );
}

/** A habit event by event, oldest first: each driver's share of corners as a square bar. */
function History({ habit, cols, events }: { habit: HabitRow; cols: Col[]; events: HabitEvent[] }) {
  const styles = useStyles();
  const t = useText();
  const wide = useWide();
  const lines = history(habit, cols.map((c) => c.id), events);
  if (lines.length === 0) return <Text style={t.small}>No event to show yet.</Text>;
  const scale = barScale(lines.flatMap((l) => l.rates));
  return (
    <View style={styles.history}>
      {lines.map((l) => (
        <View key={l.event.id} style={wide ? styles.histLine : styles.histLinePhone}>
          <Text style={StyleSheet.flatten([styles.histLabel, wide && styles.histLabelWide])} numberOfLines={wide ? 1 : 2}>
            {l.label}
          </Text>
          <View style={styles.bars}>
            {cols.map((c, i) => <Bar key={c.id} rate={l.rates[i]} color={c.color} scale={scale} />)}
          </View>
        </View>
      ))}
    </View>
  );
}

function Bar({ rate, color, scale }: { rate: number | null; color: string; scale: number }) {
  const styles = useStyles();
  if (rate == null) {
    return <View style={styles.bar}><Text style={styles.none}>Did not drive</Text></View>;
  }
  const share = Math.max(0, Math.min(1, rate / scale));
  return (
    <View style={styles.bar}>
      <View style={styles.barTrack}>
        <View style={{ width: `${Math.round(share * 100)}%`, height: '100%', backgroundColor: color }} />
      </View>
      <Text style={styles.barValue}>{pct(rate)}</Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  spin: { marginTop: 16, alignSelf: 'flex-start' },
  tracker: { gap: 28 },
  part: { gap: 10 },
  flex: { flex: 1, minWidth: 0 },

  lead: { gap: 8 },
  leadRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  who: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  code: { ...Type.label, fontSize: 15, letterSpacing: 1.4, color: c.text, marginTop: 1 },

  tableHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 6, borderBottomWidth: 1,
    borderColor: c.separator },
  headCell: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  th: { ...Type.label, fontSize: 12, color: c.text },
  row: { gap: 6, paddingVertical: 10, borderBottomWidth: 1, borderColor: c.separator },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cells: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cell: { gap: 1 },
  cellWide: { width: 220 },
  cellPhone: { width: 140 },
  rowLabel: { fontFamily: face('body', 600), fontSize: 16, lineHeight: 21, color: c.text },
  rate: { ...Type.number, fontSize: 16, color: c.text },
  unit: { ...Type.number, fontSize: 13, color: c.textSecondary },
  cost: { ...Type.number, fontSize: 13, color: c.textSecondary },
  mark: { ...Type.label, fontSize: 11, letterSpacing: 1.2, marginTop: 2 },
  none: { ...Type.number, fontSize: 13, color: c.textMuted },
  after: { marginTop: 8 },

  sides: { flexDirection: 'row', alignItems: 'flex-start', gap: 24, marginTop: 4 },
  sidesPhone: { gap: 10, marginTop: 4 },
  side: { flex: 1, minWidth: 0, gap: 2 },
  sidePhone: { minWidth: 0, gap: 2 }, // stacked: each driver's block as tall as its own lines
  figs: { ...Type.number, fontSize: 14, color: c.text, flexShrink: 1 },

  history: { gap: 8, marginTop: 6, paddingTop: 8, borderTopWidth: 1, borderColor: c.separator },
  histLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  histLinePhone: { gap: 4 },
  histLabel: { fontFamily: Fonts.body, fontSize: 13, lineHeight: 18, color: c.textSecondary },
  histLabelWide: { width: 220 },
  bars: { flex: 1, flexDirection: 'row', gap: 12 },
  bar: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 18 },
  barTrack: { flex: 1, height: 8, backgroundColor: c.fill },
  barValue: { ...Type.number, fontSize: 13, width: 56, textAlign: 'right', color: c.text },

}));
