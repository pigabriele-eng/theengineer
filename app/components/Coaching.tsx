// Coaching: the three things for the next run (TopThings) and "did we fix it" (DidWeFix), each for one run. Both load
// on their own and look again while the server is still checking the laps (lib/coaching.ts). Where they sit on a page
// is the page's call.
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { Text, View } from '@/components/Themed';
import { useWide } from '@/components/Programme';
import { Palette } from '@/constants/Colors';
import { Fonts, phaseColor, themed, Type, useTheme } from '@/constants/Theme';
import { fetchFixed, fetchTop, FixedAnswer, FixedThing, Thing, TopAnswer, Verdict, working } from '@/lib/coaching';
import type { TechniqueStatus } from '@/lib/technique';

const POLL_MS = 4000;

const seconds = (s: number) => `${s.toFixed(2)} s`;

/** One coaching answer for a run, read again while its laps are being checked. */
function useCoaching<T extends { status: TechniqueStatus }>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ answer: T | null; error: string | null }>({ answer: null, error: null });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ answer: null, error: null });
    const go = () => load().then(
      (answer) => {
        if (!live) return;
        setState({ answer, error: null });
        if (working(answer.status)) timer = setTimeout(go, POLL_MS);
      },
      (e) => live && setState({ answer: null, error: (e as Error).message }),
    );
    go();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
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
        Checking the laps against perfect driving{p && p.total ? ` (${p.done} of ${p.total})` : ''}…
      </Text>
    );
  }
  if (answer.status === 'failed') return <Text style={styles.note}>The laps couldn't be checked: {answer.error}</Text>;
  return null;
}

/** The run's three costliest repeated mistakes, each at a different corner: what to do instead and what it's worth. */
export function TopThings({ sessionId }: { sessionId: number }) {
  const styles = useStyles();
  const { answer, error } = useCoaching<TopAnswer>(() => fetchTop(sessionId), String(sessionId));
  const wait = <Waiting answer={answer} error={error} />;
  if (!answer || error || working(answer.status) || answer.status === 'failed') return wait;
  if (answer.things.length === 0) {
    return <Text style={styles.note}>No mistake repeats on this run's clean laps: nothing to single out.</Text>;
  }
  return (
    <View>
      <View style={styles.headRow}>
        <Text style={styles.head}>Three things for the next run</Text>
        <Text style={styles.headFig}>worth {seconds(answer.gain_s)} a lap</Text>
      </View>
      {answer.things.map((t) => <ThingRow key={t.key} t={t} />)}
    </View>
  );
}

function ThingRow({ t }: { t: Thing }) {
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
        {t.what ? <Text style={styles.what}>{t.lap != null ? `Lap ${t.lap}: ` : ''}{t.what}</Text> : null}
      </View>
      <View style={styles.gain}>
        <Text style={styles.gainFig}>{seconds(t.gain_s)}</Text>
        <Text style={styles.gainNote}>on {t.laps} of {t.of} laps</Text>
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
}));
