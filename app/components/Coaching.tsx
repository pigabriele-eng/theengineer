// Coaching: the three things for the next run (TopThings) and "did we fix it" (DidWeFix), each for one run. Both load
// on their own and look again while the server is still checking the laps (lib/coaching.ts). Where they sit on a page
// is the page's call.
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { Choice, useText } from '@/components/Picks';
import { Text, View } from '@/components/Themed';
import { Label, useWide } from '@/components/Programme';
import { Palette } from '@/constants/Colors';
import { face, Fonts, phaseColor, themed, Type, useTheme } from '@/constants/Theme';
import { formatLap } from '@/lib/api';
import { driverCode } from '@/lib/driverTag';
import {
  fetchFixed, fetchTop, FixedAnswer, FixedThing, lapKey, Thing, TopAnswer, Verdict, working,
} from '@/lib/coaching';
import { poll } from '@/lib/poll';
import type { TechniqueStatus } from '@/lib/technique';

const seconds = (s: number) => `${s.toFixed(2)} s`;

/** One coaching answer for a run, read again while its laps are being checked (lib/poll.ts: less and less often).
 * `keep`: the answer before stays up while a new one loads (a new pick of laps, not a new run). */
function useCoaching<T extends { status: TechniqueStatus }>(load: () => Promise<T>, key: string, keep?: string) {
  const [state, setState] = useState<{ answer: T | null; error: string | null; keep?: string }>(
    { answer: null, error: null });
  useEffect(() => {
    setState((s) => (keep != null && s.keep === keep ? { ...s, error: null } : { answer: null, error: null, keep }));
    return poll((live) => load().then(
      (answer) => {
        if (!live()) return false;
        setState({ answer, error: null, keep });
        return working(answer.status);
      },
      (e) => {
        if (live()) setState({ answer: null, error: (e as Error).message, keep });
        return false;
      },
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

function Waiting({ answer, error }: { answer: { status: TechniqueStatus; error: string | null; progress: { done: number; total: number } | null } | null; error: string | null }) {
  const styles = useStyles();
  if (error) return <Text style={styles.note}>Couldn't load: {error}</Text>;
  if (!answer) return <ActivityIndicator style={styles.loading} />;
  if (working(answer.status)) {
    const p = answer.progress;
    return (
      <Text style={styles.note}>
        Checking the laps for mistakes{p && p.total ? ` (${p.done} of ${p.total})` : ''}…
      </Text>
    );
  }
  if (answer.status === 'failed') return <Text style={styles.note}>The laps couldn't be checked: {answer.error}</Text>;
  return null;
}

/** The run's three costliest repeated mistakes, each at a different corner: what to do instead and what it's worth.
 * From the driver's laps among those picked above them (Gabriele, 2026-10-08: "let me quick pick which laps and
 * sessions i want to use for comparison"); by default each driver's best lap in the latest session. */
export function TopThings({ sessionId }: { sessionId: number }) {
  const styles = useStyles();
  const [picks, setPicks] = useState<string[] | null>(null); // the laps the three things are worked out over
  const { answer, error } = useCoaching<TopAnswer>(() => fetchTop(sessionId, picks),
    `${sessionId}:${picks?.join(',') ?? ''}`, String(sessionId));
  const wait = <Waiting answer={answer} error={error} />;
  if (!answer || error || working(answer.status) || answer.status === 'failed') return wait;
  const names = new Map(answer.choices.map((r) => [r.id, r.name]));
  const none = answer.automatic ? 'this lap' : answer.session.laps === 0 ? null : 'the laps picked';
  return (
    <View>
      <View style={styles.headRow}>
        <Text style={styles.head}>Three things for the next run</Text>
        {answer.things.length > 0 && <Text style={styles.headFig}>worth {seconds(answer.gain_s)} a lap</Text>}
      </View>
      <LapPick answer={answer} onPicks={setPicks} />
      {answer.things.length === 0
        ? <Text style={styles.note}>{none ? `No mistake on ${none}: nothing to single out.`
          : `None of ${answer.driver ?? 'this driver'}’s laps is picked: tick one to see the three things.`}</Text>
        : answer.things.map((t) => (
          <ThingRow key={t.key} t={t}
            run={t.lap_session != null && t.lap_session !== sessionId ? names.get(t.lap_session) : undefined} />
        ))}
    </View>
  );
}

/** Which laps the three things are worked out over: the event's runs (every driver's, each with its tyres) and,
 * inside the ones picked, their laps. Shut, one line says which laps; it opens on each driver's best lap in the
 * latest session. Taps wait a moment for the next before the server works the three things out again. */
function LapPick({ answer, onPicks }: { answer: TopAnswer; onPicks: (picks: string[] | null) => void }) {
  const styles = useStyles();
  const t = useText();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[] | null>(null); // null: each driver's best lap in the latest session
  // the default, as the server picked it (kept while a pick of his own is shown)
  const [auto, setAuto] = useState<string[]>([]);
  useEffect(() => {
    if (answer.automatic) setAuto(answer.picked.map(([r, n]) => lapKey(r, n)));
  }, [answer]);
  const on = new Set(draft ?? auto);

  const key = draft?.join(',') ?? '';
  useEffect(() => {
    const id = setTimeout(() => onPicks(draft && draft.length ? draft : null), 900);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const runs = answer.choices;
  if (runs.length === 0 || runs.reduce((n, r) => n + r.laps.length, 0) < 2) return null; // nothing to choose
  const set = (next: Set<string>) => {
    const keys = runs.flatMap((r) => r.laps.map((x) => lapKey(r.id, x.number))).filter((k) => next.has(k));
    const same = keys.length === auto.length && auto.every((k) => next.has(k));
    setDraft(same ? null : keys);
  };
  const flipRun = (id: number) => {
    const keys = runs.find((r) => r.id === id)!.laps.map((x) => lapKey(id, x.number));
    const next = new Set(on);
    if (keys.some((k) => next.has(k))) keys.forEach((k) => next.delete(k)); else keys.forEach((k) => next.add(k));
    set(next);
  };
  const flipLap = (k: string) => {
    const next = new Set(on);
    if (next.has(k)) next.delete(k); else next.add(k);
    set(next);
  };
  const pickedRuns = runs.filter((r) => r.laps.some((x) => on.has(lapKey(r.id, x.number))));
  const where = answer.default_title ? ` in ${answer.default_title}` : '';
  const summary = draft == null
    ? (auto.length > 1 ? `Each driver’s best lap${where}, compared with each other` : `The best lap${where}`)
    : `${on.size} lap${on.size === 1 ? '' : 's'} from ${pickedRuns.length} run${pickedRuns.length === 1 ? '' : 's'}`;
  const who = (r: { driver: string | null }) => r.driver ?? 'Driver not set';
  const tyreSet = new Set(pickedRuns.map((r) => r.tyres ?? '?'));
  return (
    <View style={styles.pick}>
      <View style={styles.pickHead}>
        <View style={styles.pickSay}>
          <Label small>Laps compared</Label>
          <Text style={t.body}>{summary}</Text>
        </View>
        <Choice label={open ? 'Done' : 'Pick laps'} on={false} onPress={() => setOpen(!open)}
          accessibilityLabel={open ? 'Done picking laps' : 'Pick the laps and runs the three things are worked out over'} />
        {draft != null && <Choice label="Clear" on={false} onPress={() => setDraft(null)}
          accessibilityLabel="Clear the picks: back to this run's own laps" />}
      </View>
      {open && (
        <>
          <View style={styles.pickRow} accessibilityRole="toolbar" accessibilityLabel="Pick runs">
            <Text style={styles.pickTitle}>Runs</Text>
            <View style={styles.choices}>
              {runs.map((r) => {
                const tyres = r.tyres_label ? `${r.tyres_label}${r.tyres_sure === false ? '?' : ''}` : 'Tyres not set';
                const code = r.driver ? driverCode(r.driver) : '?';
                return (
                  <Choice key={r.id} label={r.name}
                    detail={`${code} · ${tyres} · ${r.laps.length} lap${r.laps.length === 1 ? '' : 's'}`}
                    on={r.laps.some((x) => on.has(lapKey(r.id, x.number)))} onPress={() => flipRun(r.id)}
                    accessibilityLabel={`${r.name}, ${who(r)}: ${tyres} tyres, ${r.laps.length} clean laps`} />
                );
              })}
            </View>
          </View>
          {pickedRuns.map((r) => (
            <View key={r.id} style={styles.pickRow} accessibilityRole="toolbar" accessibilityLabel={`Pick laps of ${r.name}`}>
              <Text style={styles.pickTitle}>Laps of {r.name}, {who(r)}</Text>
              <View style={styles.choices}>
                {r.laps.map((x) => {
                  const k = lapKey(r.id, x.number);
                  return (
                    <Choice key={k} label={`Lap ${x.number}`} detail={formatLap(x.time)} on={on.has(k)}
                      onPress={() => flipLap(k)} accessibilityLabel={`${r.name} lap ${x.number}, ${formatLap(x.time)}`} />
                  );
                })}
              </View>
            </View>
          ))}
          <Text style={t.body}>
            {tyreSet.size > 1 ? 'These runs are on different tyres: like for like compares best.'
              : 'Tick a run for all its laps, then take off the laps you want left out. The three things come from '
                + `${answer.driver ?? 'this driver'}’s laps; the other drivers’ show what the same mistake costs them.`}
          </Text>
        </>
      )}
    </View>
  );
}

function ThingRow({ t, run }: { t: Thing; run?: string }) {
  const styles = useStyles();
  const c = useTheme();
  const wide = useWide();
  return (
    <View style={[styles.row, !wide && styles.rowPhone]}>
      <Text style={styles.rank}>{t.rank}</Text>
      <View style={[styles.code, { borderLeftColor: phaseColor(c, t.phase) }]}>
        <Text style={styles.codeText}>{t.code}</Text>
        <Text style={styles.phase}>{t.phase}</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.title}>{t.title}</Text>
        {t.do ? <Text style={styles.do}>{t.do}</Text> : null}
        {t.what ? <Text style={styles.what}>{t.lap != null ? `${run ? `${run} lap` : 'Lap'} ${t.lap}: ` : ''}{t.what}</Text> : null}
        {t.others?.length ? (
          <Text style={styles.what}>
            Same corner: {t.others.map((o) => `${o.driver ?? 'driver not set'} ${seconds(o.cost_s)}${o.laps > 1 ? ' a lap' : ''}`)
              .join(', ')}
          </Text>
        ) : null}
      </View>
      <View style={styles.gain}>
        <Text style={styles.gainFig}>{seconds(t.gain_s)}</Text>
        <Text style={styles.gainNote}>{t.of === 1 ? (t.lap != null ? `on lap ${t.lap}` : 'on the lap') : `on ${t.laps} of ${t.of} laps`}</Text>
      </View>
    </View>
  );
}

const VERDICT: Record<Verdict, { label: string; tone: (c: Palette) => string }> = {
  fixed: { label: 'Fixed', tone: (c) => c.status.good },
  better: { label: 'Better', tone: (c) => c.status.warning },
  'not yet': { label: 'Not yet', tone: (c) => c.status.serious },
};

/** Did we fix it: the previous run's three things, each as it costs on this run. previous picks the run to compare
 * with; by default the latest earlier run at the same track by the same driver. */
export function DidWeFix({ sessionId, previous }: { sessionId: number; previous?: number | null }) {
  const styles = useStyles();
  const { answer, error } = useCoaching<FixedAnswer>(() => fetchFixed(sessionId, previous),
    `${sessionId}:${previous ?? ''}`);
  const wait = <Waiting answer={answer} error={error} />;
  if (!answer || error || working(answer.status) || answer.status === 'failed') return wait;
  if (!answer.previous) return <Text style={styles.note}>{answer.note ?? 'No earlier run to compare with.'}</Text>;
  if (answer.things.length === 0) {
    return <Text style={styles.note}>{answer.previous.name} had no repeated mistake to work on.</Text>;
  }
  const gained = answer.gained_s ?? 0;
  return (
    <View>
      <View style={styles.headRow}>
        <Text style={styles.head}>Did we fix it? Against {answer.previous.name}</Text>
        <Text style={styles.headFig}>{gained >= 0 ? 'gained' : 'lost'} {seconds(Math.abs(gained))} a lap</Text>
      </View>
      {answer.things.map((t) => <FixedRow key={t.key} t={t} />)}
    </View>
  );
}

function FixedRow({ t }: { t: FixedThing }) {
  const styles = useStyles();
  const c = useTheme();
  const wide = useWide();
  const v = VERDICT[t.verdict];
  return (
    <View style={[styles.row, !wide && styles.rowPhone]}>
      <View style={[styles.verdict, { backgroundColor: v.tone(c) }]}>
        <Text style={styles.verdictText}>{v.label}</Text>
      </View>
      <View style={[styles.code, { borderLeftColor: phaseColor(c, t.phase) }]}>
        <Text style={styles.codeText}>{t.code}</Text>
        <Text style={styles.phase}>{t.phase}</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.title}>{t.title}</Text>
        <Text style={styles.what}>
          Cost {seconds(t.before.cost_s)} a lap before ({t.before.laps} of {t.before.of} laps), {seconds(t.after.cost_s)} now
          ({t.after.laps} of {t.after.of} laps)
        </Text>
      </View>
      <View style={styles.gain}>
        <Text style={styles.gainFig}>{t.gained_s >= 0 ? '−' : '+'}{seconds(Math.abs(t.gained_s))}</Text>
        <Text style={styles.gainNote}>a lap</Text>
      </View>
    </View>
  );
}

const useStyles = themed((c: Palette) => ({
  loading: { alignSelf: 'flex-start', marginVertical: 12 },
  note: { ...Type.dek, fontSize: 15, lineHeight: 21, color: c.textSecondary, marginTop: 10 },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8,
    borderBottomWidth: 3, borderColor: c.rule, paddingBottom: 6 },
  head: { ...Type.label, color: c.text },
  headFig: { ...Type.number, fontSize: 15, color: c.text },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 12, borderBottomWidth: 1,
    borderColor: c.separator },
  rowPhone: { flexWrap: 'wrap', gap: 10 },
  rank: { ...Type.display, fontSize: 40, lineHeight: 42, width: 30, color: c.text },
  code: { borderLeftWidth: 6, paddingLeft: 8, width: 84 },
  codeText: { ...Type.display, fontSize: 22, lineHeight: 26, color: c.text },
  phase: { ...Type.label, fontSize: 10, color: c.textSecondary },
  body: { flex: 1, minWidth: 220 },
  title: { ...Type.label, fontSize: 14, color: c.text },
  do: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.text, marginTop: 4 },
  what: { fontFamily: Fonts.body, fontSize: 14, lineHeight: 20, color: c.textSecondary, marginTop: 4 },
  gain: { alignItems: 'flex-end', width: 90 },
  gainFig: { ...Type.number, fontSize: 22, color: c.text },
  gainNote: { ...Type.label, fontSize: 10, color: c.textSecondary },
  verdict: { paddingHorizontal: 8, paddingVertical: 4, width: 76, alignItems: 'center' },
  verdictText: { ...Type.label, fontSize: 12, color: c.onTint },
  pick: { gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderColor: c.separator },
  pickHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 8 },
  pickSay: { flex: 1, minWidth: 200 },
  pickRow: { gap: 6 },
  pickTitle: { fontFamily: face('label', 400), fontSize: 16, color: c.textSecondary },
  choices: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, rowGap: 8 },
}));
