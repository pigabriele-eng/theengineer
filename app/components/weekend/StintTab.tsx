// The weekend page's Stint analysis tab (Gabriele, 2026-10-15: "Stint analysis: 1- balance shift throughout stint
// 2- tire degradation and fuel load effect"). The weekend's stints come from the event's stint view (GET /stint with
// every run's main log, server/app/analysis/stint.py, kept once worked out), race stints first, each named with its
// driver, one tap to switch (lib/stintTab.ts). Section `no`: how the balance moves through the stint, in each phase
// (entry, mid-corner, exit): where it moved most, in words and corner by corner, and lap by lap, the whole lap's
// beside one corner's. Section `no + 1`: the seconds a lap the tyres cost against what burning fuel gives back, and
// the net, with how sure each is; then the lap times and the laps, where a lap lost to a safety car, an FCY or traffic
// is tagged out of the trends (both sections read the trends without it). The pieces are the Stint analysis page's
// (app/tools/stint.tsx): components/StintBalance.tsx and components/StintLaps.tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { ErrorLine, Note } from '@/components/Controls';
import { FigRow, Tabs, useText } from '@/components/Picks';
import { Fig, Section, TextLink, useWide } from '@/components/Programme';
import { BalanceLaps, CornerShift } from '@/components/StintBalance';
import { LapList, LapTimes, OnTag } from '@/components/StintLaps';
import { Text, View } from '@/components/Themed';
import { codeOf } from '@/lib/driverTag';
import { Folder, sessionsInOrder } from '@/lib/events';
import { BalancePhase, clearLapTag, fetchStintLogs, fetchStintView, putLapTag, signed, Stint, StintView } from '@/lib/stint';
import {
  balanceWords, driverOf, fuelSplit, MIN_TREND_LAPS, PHASE_LABEL, RunInfo, shifts, Split, splitWords, stintChoices,
  stintTitle,
} from '@/lib/stintTab';
import { themed, useTheme } from '@/constants/Theme';

export default function StintTab({ no, eventId, folder }: { no: number; eventId: number; folder: Folder | null }) {
  const styles = useStyles();
  const tx = useText();

  // the event's main logs (each run's longest, with laps), then their stints: read again when the event's runs change
  const [view, setView] = useState<StintView | null>(null);
  const [files, setFiles] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const load = useCallback(() => {
    const n = ++request.current;
    setBusy(true);
    setError(null);
    fetchStintLogs()
      .then((events) => {
        const ev = events.find((e) => e.id === eventId);
        const mains = (ev?.sessions ?? []).flatMap((s) => s.files.filter((f) => f.main && f.laps > 0).slice(-1))
          .map((f) => f.id);
        if (n !== request.current) return null;
        setFiles(mains);
        return mains.length ? fetchStintView(mains) : null;
      })
      .then((v) => n === request.current && setView(v))
      .catch((e) => n === request.current && setError((e as Error).message))
      .finally(() => n === request.current && setBusy(false));
  }, [eventId]);
  useEffect(load, [load, folder]);

  // the runs as the weekend names them, in the order they ran, each with its driver's code
  const runs: RunInfo[] = useMemo(() => {
    const own = sessionsInOrder(folder).map((s) => ({ id: s.id, name: s.name, kind: s.kind, driver: codeOf(s.driver) }));
    const seen = new Set(own.map((r) => r.id));
    const more = (view?.logs ?? []).filter((l) => l.session_id != null && !seen.has(l.session_id))
      .map((l) => ({ id: l.session_id!, name: l.name, kind: null, driver: null }));
    return [...own, ...more];
  }, [folder, view]);

  const [pick, setPick] = useState<string | null>(null);
  const { choices, short } = useMemo(() => stintChoices(view?.stints ?? [], runs, pick), [view, runs, pick]);
  const key = choices.some((c) => c.key === pick) ? pick : choices[0]?.key ?? null;
  const stint = view?.stints.find((s) => s.key === key) ?? null;
  const name = stint ? `${stintTitle(stint, view!.stints, runs)} · ${driverOf(stint, runs)}` : '';

  // a lap tagged (or its tag cleared): the trends are worked out again without it
  const [tagging, setTagging] = useState<string | null>(null);
  const tag: OnTag = async (s, lap, to) => {
    if (s.file_id == null) return;
    setTagging(`${s.key}:${lap.lap}`);
    try {
      if (to == null) await clearLapTag(s.file_id, lap.lap);
      else await putLapTag(s.file_id, lap.lap, to);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTagging(null);
    }
  };

  const status = error ? <ErrorLine>{`Can’t read the stints: ${error}`}</ErrorLine>
    : !view && (busy || files == null) ? (
      <View style={styles.working} accessibilityLiveRegion="polite">
        <ActivityIndicator />
        <Note>Reading the weekend’s logs: the first time takes a minute.</Note>
      </View>
    ) : !view || choices.length === 0 ? (
      <Note>
        {short.length ? `No stint has the ${MIN_TREND_LAPS} laps in the trend it takes: ${short.join(', ')}.`
          : 'No stints yet: they show here once a run’s log with laps is uploaded.'}
      </Note>
    ) : null;
  const picker = choices.length > 1 ? (
    <Tabs label="Stint" value={key} onChange={setPick} style={styles.picker}
      items={choices.map((c) => ({ key: c.key as string | null, label: c.label, sub: c.sub }))} />
  ) : null;
  const named = stint && (
    <Text style={StyleSheet.flatten([tx.label, styles.named])}>
      {`${name} · laps ${stint.first_lap}–${stint.last_lap}${busy ? ' · updating…' : ''}`}
    </Text>
  );

  return (
    <>
      <Section no={no} title="Balance through the stint"
        dek={`How the car’s balance moves over the stint in each phase of a corner: the understeer angle against the car’s normal at the same cornering g${view?.understeer_per_g != null ? ` (${view.understeer_per_g.toFixed(2)}° per g)` : ''}, + understeer, − oversteer. Laps tagged SC, FCY or traffic stay out.`}>
        {status}
        {picker}
        {short.length > 0 && choices.length > 0 && (
          <Text style={StyleSheet.flatten([tx.small, styles.short])}>
            {`Too few laps in the trend to show: ${short.join(', ')}.`}
          </Text>
        )}
        {stint && !picker && named}
        {stint && <Balance key={stint.key} stint={stint} />}
      </Section>
      <Section no={no + 1} title="Tyres and fuel"
        dek="What the tyres cost a lap as they wear against what burning fuel gives back, and the net, on the laps in the trend. ± is the 95 % band of the trend: the lap-to-lap scatter.">
        {status}
        {stint && named}
        {stint && <TyresAndFuel stint={stint} onTag={tag} tagging={tagging} />}
      </Section>
    </>
  );
}

/** Where the balance moved most, in words; corner by corner, early laps against late laps; lap by lap, the whole lap
 * beside one corner. One phase at a time, at first the one with the biggest shift. */
function Balance({ stint }: { stint: Stint }) {
  const styles = useStyles();
  const tx = useText();
  const all = useMemo(() => shifts(stint), [stint]);
  const w = balanceWords(stint);
  const top = (p: BalancePhase) => all.find((s) => s.phase === p)?.code ?? null;
  const [phase, setPhase] = useState<BalancePhase>(all[0]?.phase ?? 'entry');
  const [corner, setCorner] = useState<string | null>(all[0]?.code ?? null);
  const turn = (p: BalancePhase) => {
    setPhase(p);
    setCorner(top(p));
  };
  return (
    <View style={styles.block}>
      <Text style={StyleSheet.flatten([tx.lead, styles.words])} accessibilityLiveRegion="polite">{w.headline}</Text>
      {[w.next, w.sure, w.whole].filter(Boolean).map((s) => (
        <Text key={s} style={StyleSheet.flatten([tx.body, styles.words])}>{s}</Text>
      ))}
      {stint.groups && (
        <>
          <Text style={StyleSheet.flatten([tx.sub, styles.sub])}>Corner by corner: early laps against late laps</Text>
          <CornerShift sections={stint.sections} stints={[stint]} phase={phase} onPhase={turn} />
          <Text style={StyleSheet.flatten([tx.sub, styles.sub])}>{`Lap by lap: ${PHASE_LABEL[phase].toLowerCase()}`}</Text>
          <View style={styles.narrow}>
            <BalanceLaps stint={stint} phase={phase} corner={corner} onCorner={setCorner} />
          </View>
        </>
      )}
    </View>
  );
}

/** The tyres against the fuel, and the net: three figures, the words and how sure each is; then the lap times and
 * the laps to tag. */
function TyresAndFuel({ stint, onTag, tagging }: { stint: Stint; onTag: OnTag; tagging: string | null }) {
  const styles = useStyles();
  const tx = useText();
  const theme = useTheme();
  const wide = useWide();
  const [open, setOpen] = useState(false);
  const sp: Split = fuelSplit(stint);
  const w = splitWords(sp);
  // the laps in the trend that look slowed by something outside the car (a lap left out already doesn't count)
  const pending = stint.laps.filter((l) => l.in_fit && l.suggestion && !l.tag).length;
  const barOf = (d: number | null) =>
    d == null || Math.abs(d) < 0.005 ? theme.rule : d > 0 ? theme.delta.loss : theme.delta.gain;
  const band = (p: { within: number | null; clear: boolean | null }) =>
    `±${(p.within ?? 0).toFixed(2)} · ${p.clear ? 'clear' : 'within scatter'}`;
  const tiles = [
    sp.tyres && { label: 'Tyres', value: signed(sp.tyres.per_lap), note: band(sp.tyres), delta: sp.tyres.per_lap },
    sp.fuel && { label: 'Fuel burn', value: signed(sp.fuel.per_lap),
      note: `${sp.fuel.kg_per_lap?.toFixed(2) ?? '–'} kg/lap · ${sp.fuel.measured ? 'measured' : 'estimate'}`,
      delta: sp.fuel.per_lap },
    sp.net && { label: sp.tyres ? 'Net' : 'Lap time', value: signed(sp.net.per_lap), note: band(sp.net),
      delta: sp.net.per_lap },
  ].filter(Boolean) as { label: string; value: string; note: string; delta: number }[];
  return (
    <View style={styles.block}>
      {tiles.length > 0 && (
        <FigRow phoneCols={tiles.length === 3 ? 3 : 2}>
          {tiles.map((t) => (
            <Fig key={t.label} label={t.label} value={t.value} unit="s/lap" size={wide ? 52 : 30} bar={barOf(t.delta)}
              barHeight={6} note={t.note} />
          ))}
        </FigRow>
      )}
      <Text style={StyleSheet.flatten([tx.lead, styles.words])}>{w.headline}</Text>
      {w.sure.length > 0 && (
        <View style={styles.sure}>
          <Text style={tx.sub}>How sure</Text>
          {w.sure.map((s) => (
            <View key={s} style={styles.bullet}>
              <View style={styles.bulletMark} />
              <Text style={StyleSheet.flatten([tx.body, styles.flex])}>{s}</Text>
            </View>
          ))}
        </View>
      )}
      <View style={styles.narrow}>
        <LapTimes stint={stint} />
      </View>
      {pending > 0 && (
        <Text style={StyleSheet.flatten([tx.body, styles.words])}>
          {`${pending === 1 ? '1 lap in the trend looks' : `${pending} laps in the trend look`} slowed by traffic, a safety car or an FCY: tag ${pending === 1 ? 'it' : 'them'} below and the figures above leave ${pending === 1 ? 'it' : 'them'} out.`}
        </Text>
      )}
      <TextLink label={open ? 'Hide the laps' : `Every lap, to tag SC, FCY or traffic${pending ? ` (${pending} to check)` : ''}`}
        onPress={() => setOpen(!open)} arrow={!open} red={pending > 0} />
      {open && (
        <View style={styles.narrow}>
          <LapList stint={stint} onTag={onTag} tagging={tagging} />
        </View>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  working: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  picker: { marginBottom: 6 },
  short: { marginBottom: 8 },
  named: { marginTop: 8, marginBottom: 14 },
  block: { gap: 14, backgroundColor: 'transparent' },
  narrow: { maxWidth: 760, backgroundColor: 'transparent' },
  words: { maxWidth: 820 },
  sub: { marginTop: 14, maxWidth: 760 },
  sure: { gap: 8, maxWidth: 820 },
  flex: { flex: 1, minWidth: 0 },
  bullet: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  bulletMark: { width: 7, height: 7, backgroundColor: c.text, marginTop: 8 },
}));
