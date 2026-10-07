import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';

import PrintButton from '@/components/PrintButton';
import { Block, Colophon, Fig, Label, Page, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import {
  Actions,
  CarGrid,
  ErrorLine,
  Field,
  FieldGrid,
  InlineLink,
  MainAction,
  Note,
  Opening,
  Options,
  SubHead,
} from '@/components/ToolForm';
import { api, Session } from '@/lib/api';
import {
  Axle,
  Corner,
  CORNERS,
  num,
  parsePyrometer,
  PerCorner,
  Reading,
  Reference,
  TempAnalysis,
  tyres,
} from '@/lib/tyres';
import { Fonts, inkOn, Palette, themed, Type, useTheme } from '@/constants/Theme';

type Mode = 'pyrometer' | 'paste' | 'log';
const MODES: { value: Mode; label: string }[] = [
  { value: 'pyrometer', label: 'Type readings' },
  { value: 'paste', label: 'Paste readings' },
  { value: 'log', label: 'IR sensors in a log' },
];
type Pos = 'inside' | 'middle' | 'outside';
const SHORT: Record<Pos, string> = { inside: 'In', middle: 'Mid', outside: 'Out' };
// Seen from above, the outside edge of a left tyre is on the left, of a right tyre on the right.
const ACROSS: Record<Corner, Pos[]> = {
  FL: ['outside', 'middle', 'inside'],
  RL: ['outside', 'middle', 'inside'],
  FR: ['inside', 'middle', 'outside'],
  RR: ['inside', 'middle', 'outside'],
};

// A figure from an older public booklet, with a link to it.
function Ref({ r }: { r: Reference }) {
  return (
    <Note small>
      {r.text} <InlineLink label="Source" url={r.source} />
    </Note>
  );
}

/** Tyre temperatures: readings across each tyre in (typed, pasted, or IR sensors in a log), the target spread, then
 * the camber and pressure advice per tyre and the car's balance. */
export default function TyreTempsScreen() {
  const styles = useStyles();
  const wide = useWide();
  const [mode, setMode] = useState<Mode>('pyrometer');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [paste, setPaste] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [spread, setSpread] = useState<Record<Axle, string>>({ front: '', rear: '' });
  const [spreadSource, setSpreadSource] = useState<string | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [defaultSpread, setDefaultSpread] = useState<number | null>(null);
  const [series, setSeries] = useState('');
  const [result, setResult] = useState<TempAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    tyres.tempSettings().then((s) => {
      setSpread({ front: String(s.target_spread_c), rear: String(s.target_spread_c) });
      setSpreadSource(s.target_spread_source);
      setDefaultSpread(s.target_spread_c);
      setReference(s.reference);
    }, (e) => setError(e.message));
    api.sessions().then((s) => {
      setSessions(s);
      setSessionId((cur) => cur ?? s[0]?.id ?? null);
    }, () => {});
  }, []);

  const set = (k: string) => (v: string) => setVals((cur) => ({ ...cur, [k]: v }));

  const readings = (): PerCorner<Reading> => {
    const out: PerCorner<Reading> = {};
    for (const c of CORNERS) {
      const [inside, middle, outside] = (['inside', 'middle', 'outside'] as const).map((p) => num(vals[`${c}-${p}`]));
      if (inside === undefined || middle === undefined || outside === undefined) continue;
      out[c] = { inside, middle, outside, pressure_bar: num(vals[`${c}-p`]), camber_deg: num(vals[`${c}-camber`]) };
    }
    return out;
  };

  const applyPaste = () => {
    const { readings: r, errors } = parsePyrometer(paste);
    const next = { ...vals };
    for (const [c, x] of Object.entries(r) as [Corner, Reading][]) {
      next[`${c}-inside`] = String(x.inside);
      next[`${c}-middle`] = String(x.middle);
      next[`${c}-outside`] = String(x.outside);
      if (x.pressure_bar != null) next[`${c}-p`] = String(x.pressure_bar);
      if (x.camber_deg != null) next[`${c}-camber`] = String(x.camber_deg);
    }
    setVals(next);
    setError(errors.length ? errors.join('\n') : null);
    if (Object.keys(r).length) setMode('pyrometer');
  };

  const analyse = async () => {
    // send a target only when it differs from the default, so the reply says whose number it is
    const entered = Object.fromEntries(
      (['front', 'rear'] as const).map((a) => [a, num(spread[a])]).filter(([, v]) => v !== undefined),
    ) as Partial<Record<Axle, number>>;
    const target = Object.values(entered).some((v) => v !== defaultSpread) ? entered : undefined;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'log') {
        if (sessionId == null) throw new Error('Pick a session with a log first.');
        setResult(await tyres.logTemps(sessionId, target));
      } else {
        const r = readings();
        if (!Object.keys(r).length) throw new Error('Enter inside, middle and outside for at least one tyre.');
        setResult(
          await tyres.analyzeTemps({
            readings: r,
            target_spread_c: target,
            series: series.trim() || undefined,
          }),
        );
      }
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Tyre temperatures' }} />
      <Opening title="Tyre temperatures"
        dek="Temperatures across each tyre straight after a run: inside (nearest the car’s centre), middle and outside, in °C. You get camber and pressure advice per tyre and the car’s balance.">
        <PrintButton title="Tyre temperatures" />
      </Opening>

      <Section no={1} title="Readings" dek="Typed in from the pyrometer, pasted from your notes, or read from IR sensors in a log.">
        <Options label="Where the readings come from" value={mode} onPick={setMode} options={MODES} />

        {mode === 'pyrometer' && (
          <>
            <CarGrid style={styles.grid}
              cell={(c) => (
                <View style={styles.cell}>
                  <View style={styles.across}>
                    {ACROSS[c].map((p) => (
                      <Field key={p} small label={SHORT[p]} align="center" value={vals[`${c}-${p}`] ?? ''}
                        onChangeText={set(`${c}-${p}`)} accessibilityLabel={`${c} ${p} temperature`} />
                    ))}
                  </View>
                  <View style={styles.across}>
                    <Field small label="Hot bar" align="center" value={vals[`${c}-p`] ?? ''} onChangeText={set(`${c}-p`)}
                      keyboardType="decimal-pad" placeholder="opt." accessibilityLabel={`${c} hot pressure, bar`} />
                    <Field small label="Camber °" align="center" value={vals[`${c}-camber`] ?? ''}
                      onChangeText={set(`${c}-camber`)} placeholder="opt." accessibilityLabel={`${c} camber, degrees`} />
                  </View>
                </View>
              )}
            />
            <Note small style={styles.gapTop}>Hot pressure and camber are optional; with them the advice gives new values.</Note>
          </>
        )}

        {mode === 'paste' && (
          <View style={styles.paste}>
            <Note small>
              One tyre per line: corner, inside, middle, outside, and optionally hot pressure and camber. For example
              {'\n'}FL 92 88 84 1.85 -3.5
            </Note>
            <Field boxed value={paste} onChangeText={setPaste} multiline keyboardType="default"
              accessibilityLabel="Readings, one tyre per line"
              placeholder={'FL 92 88 84\nFR 90 87 85\nRL 80 78 77\nRR 79 78 76'} inputStyle={styles.pasteBox} />
            <TextLink onPress={applyPaste} label="Use these readings" arrow />
          </View>
        )}

        {mode === 'log' && (
          <View style={styles.paste}>
            <Note small>
              Uses IR tyre sensors (inside, middle and outside channels) in the session’s log, averaged at racing
              speed. TPMS temperatures can’t be used: they measure the air inside the tyre.
            </Note>
            {sessions.length === 0 ? <Note small>No sessions yet.</Note> : (
              <Options label="Session" value={sessionId} onPick={setSessionId}
                options={sessions.slice(0, 8).map((s) => ({ value: s.id, label: s.name ?? `Session ${s.id}` }))} />
            )}
          </View>
        )}
      </Section>

      <Section no={2} title="Target spread" dek="How much hotter the inside edge should run than the outside, in °C.">
        <FieldGrid columns={wide ? 4 : 2}>
          <Field label="Front" unit="°C" value={spread.front} onChangeText={(v) => setSpread((s) => ({ ...s, front: v }))} />
          <Field label="Rear" unit="°C" value={spread.rear} onChangeText={(v) => setSpread((s) => ({ ...s, rear: v }))} />
        </FieldGrid>
        {spreadSource ? <Note small style={styles.gapTop}>{spreadSource}</Note> : null}
        {reference ? <View style={styles.gapTop}><Ref r={reference} /></View> : null}
        {mode !== 'log' && (
          <View style={styles.series}>
            <Field label="Series" unit="(optional, checks pressures against its P-Book hot minimum)" value={series}
              onChangeText={setSeries} keyboardType="default" placeholder="e.g. GT4 Germany" />
          </View>
        )}
        <Actions>
          <MainAction label="Analyse" onPress={analyse} busy={busy} />
        </Actions>
        {error ? <View style={styles.gapTop}><ErrorLine>{error}</ErrorLine></View> : null}
      </Section>

      {result && <Results result={result} />}

      <Colophon left="The Engineer · Tyre temperatures" links={[
        { label: 'Tyre pressures', href: '/tools/pressures' },
        { label: 'Tyre fit', href: '/tools/tyre-fit' },
        { label: 'Setup', href: '/tools/setup' },
      ]} />
    </Page>
  );
}

const VERDICT: Record<string, string> = {
  ok: 'OK',
  'less negative camber': 'Less camber',
  'more negative camber': 'More camber',
  lower: 'Lower',
  raise: 'Raise',
};

/** The tyre colour of a pressure verdict: raise it (running cold), lower it (running hot), or right. */
const pressureTone = (theme: Palette, verdict: string) =>
  verdict === 'raise' ? theme.tyre.cold : verdict === 'lower' ? theme.tyre.hot : verdict === 'ok' ? theme.tyre.ok : undefined;

function Results({ result }: { result: TempAnalysis }) {
  const c = useTheme();
  const styles = useStyles();
  const wide = useWide();
  const by = Object.fromEntries(result.tyres.map((t) => [t.corner, t]));
  return (
    <Section no={3} title="Advice" dek={result.file ? `From ${result.file}.` : 'Average across each tyre, and what to change.'}>
      <CarGrid
        cell={(k) => {
          const t = by[k];
          if (!t) return <Text style={styles.dash}>–</Text>;
          const tone = pressureTone(c, t.pressure.verdict);
          return (
            <View>
              <Fig value={t.average_c.toFixed(0)} unit="°C" size={wide ? 72 : 46} bar={tone ?? c.rule} barHeight={6} />
              <Text style={styles.across3}>
                {ACROSS[k].map((p) => `${SHORT[p]} ${t[p]}`).join(' · ')}
              </Text>
              <View style={styles.verdicts}>
                <View style={styles.verdict}>
                  <Label small muted>Camber</Label>
                  <Text style={styles.verdictText}>
                    {VERDICT[t.camber.verdict] ?? t.camber.verdict}{' '}
                    <Text style={styles.spread}>({t.camber.spread_c > 0 ? '+' : ''}{t.camber.spread_c.toFixed(0)})</Text>
                  </Text>
                </View>
                <View style={styles.verdict}>
                  <Label small muted>Pressure</Label>
                  {tone ? (
                    <Block label={VERDICT[t.pressure.verdict] ?? t.pressure.verdict} color={tone} ink={inkOn(tone)} />
                  ) : (
                    <Text style={styles.verdictText}>{VERDICT[t.pressure.verdict] ?? t.pressure.verdict}</Text>
                  )}
                </View>
              </View>
            </View>
          );
        }}
      />

      {result.balance.length > 0 && <SubHead style={styles.subGap}>Balance</SubHead>}
      {result.balance.map((b) => (
        <View key={b.kind} style={styles.balance}>
          <Text style={styles.body}>{b.text}</Text>
          {b.references.map((r) => <Ref key={r.text} r={r} />)}
        </View>
      ))}

      <SubHead style={styles.subGap}>Tyre by tyre</SubHead>
      {result.tyres.map((t) => (
        <View key={t.corner} style={styles.why}>
          <View style={styles.whyHead}>
            <Block label={t.corner} color={c.rule} ink={c.background} size={13} />
            <Text style={styles.whyTemps}>In {t.inside} · mid {t.middle} · out {t.outside} °C</Text>
          </View>
          <View style={wide ? styles.whyCols : undefined}>
            <View style={wide ? styles.whyCol : undefined}>
              <Label small muted>Camber</Label>
              <Text style={styles.body}>{t.camber.text}</Text>
              {t.camber.references.map((r) => <Ref key={r.text} r={r} />)}
            </View>
            <View style={wide ? styles.whyCol : styles.whyNext}>
              <Label small muted>Pressure</Label>
              <Text style={t.pressure.below_minimum ? styles.bodyError : styles.body}>{t.pressure.text}</Text>
            </View>
          </View>
        </View>
      ))}
      <Note small style={styles.gapTop}>
        Target spread front {result.target_spread_c.front} °C, rear {result.target_spread_c.rear} °C (
        {result.target_spread_source === 'entered' ? 'entered' : 'estimate'}). Change one thing at a time and measure
        again.
      </Note>
    </Section>
  );
}

const useStyles = themed((c) => ({
  grid: { marginTop: 18 },
  cell: { gap: 12 },
  across: { flexDirection: 'row', gap: 8 },
  gapTop: { marginTop: 12 },
  paste: { gap: 14, marginTop: 18, maxWidth: 640 },
  pasteBox: { minHeight: 120 },
  series: { marginTop: 20, maxWidth: 640 },
  dash: { fontFamily: Fonts.display, fontSize: 40, color: c.textMuted },
  across3: { fontFamily: Fonts.label, fontSize: 13, fontVariant: ['tabular-nums'], color: c.textSecondary, marginTop: 8 },
  verdicts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 8, marginTop: 10 },
  verdict: { gap: 3 },
  verdictText: { fontFamily: Type.label.fontFamily, fontSize: 14, color: c.text },
  spread: { fontFamily: Fonts.label, fontSize: 13, fontVariant: ['tabular-nums'], color: c.textSecondary },
  subGap: { marginTop: 28 },
  balance: { gap: 4, paddingVertical: 6 },
  body: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text },
  bodyError: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.error },
  why: { borderBottomWidth: 1, borderColor: c.separator, paddingTop: 10, paddingBottom: 12, gap: 6 },
  whyHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  whyTemps: { fontFamily: Fonts.label, fontSize: 14, fontVariant: ['tabular-nums'], color: c.text },
  whyCols: { flexDirection: 'row', gap: 28 },
  whyCol: { flex: 1, minWidth: 0, gap: 3 },
  whyNext: { marginTop: 8, gap: 3 },
}));
