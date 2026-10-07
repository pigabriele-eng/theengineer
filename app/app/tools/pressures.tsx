import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

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
  useTableStyles,
  WarnLine,
  Working,
} from '@/components/ToolForm';
import { eventLabel, NotSet, toolLists, TyreKind } from '@/lib/toolLists';
import {
  Axle,
  Corner,
  CORNERS,
  LoggedRun,
  num,
  PerCorner,
  PressurePlan,
  Reference,
  RunSummary,
  tyres,
} from '@/lib/tyres';
import { Fonts, inkOn, themed, Type, useTheme } from '@/constants/Theme';

const AXLE_OF: Record<Corner, Axle> = { FL: 'front', FR: 'front', RL: 'rear', RR: 'rear' };

const empty = (): Record<Corner, string> => ({ FL: '', FR: '', RL: '', RR: '' });
const fmt = (x: number | null | undefined, digits = 2) => (x == null ? '–' : x.toFixed(digits));

// A figure from an older public booklet, with a link to it.
function Ref({ r }: { r: Reference }) {
  return (
    <Note small>
      {r.text} <InlineLink label="Source" url={r.source} />
    </Note>
  );
}

/** The pressure calculator: the tyre, today's conditions and the hot targets in, the cold pressures to set out (by
 * the gas law and by the logged runs on that tyre), then the tyre's P-Book pressures and the runs it learns from. */
export default function PressuresScreen() {
  const styles = useStyles();
  const wide = useWide();
  const [ambient, setAmbient] = useState('');
  const [track, setTrack] = useState('');
  const [setTemp, setSetTemp] = useState('');
  const [atmos, setAtmos] = useState('1.013');
  const [targets, setTargets] = useState(empty);
  const [hotTemps, setHotTemps] = useState(empty);
  const [kinds, setKinds] = useState<TyreKind[] | null>(null);
  const [notSet, setNotSet] = useState<NotSet | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [kindId, setKindId] = useState<number | null>(null);
  const [runs, setRuns] = useState<LoggedRun[] | null>(null);
  const [summary, setSummary] = useState<PerCorner<RunSummary>>({});
  const [plan, setPlan] = useState<PressurePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = kinds?.find((k) => k.id === kindId) ?? null;

  // the garage's tyres, again on coming back (a tyre may have been added there)
  const loadKinds = useCallback(() => {
    toolLists.tyres().then(
      (r) => {
        setKinds(r.tyres);
        setNotSet(r.not_set);
        setReference(r.reference);
        setKindId((cur) => (cur != null && r.tyres.some((t) => t.id === cur) ? cur : (r.tyres[0]?.id ?? null)));
      },
      (e) => setError(e.message),
    );
  }, []);
  useFocusEffect(loadKinds);

  // only the runs on the tyre picked: reading the logs takes a moment
  const loadRuns = useCallback(() => {
    setRuns(null);
    setSummary({});
    if (kindId == null) return;
    tyres.runs({ tyreKindId: kindId }).then(
      (r) => {
        setRuns(r.runs);
        setSummary(r.summary);
      },
      (e) => setError(e.message),
    );
  }, [kindId]);
  useEffect(loadRuns, [loadRuns]);

  // the tyre's P-Book hot targets fill the targets (a target with none for its axle stays as typed)
  const hotTarget = kind?.pbook.hot_target_bar;
  useEffect(() => {
    setPlan(null);
    if (!hotTarget) return;
    setTargets((cur) => {
      const next = { ...cur };
      for (const c of CORNERS) {
        const t = hotTarget[AXLE_OF[c]];
        if (t != null) next[c] = String(t);
      }
      return next;
    });
  }, [kindId, hotTarget?.front, hotTarget?.rear]);

  const calculate = async () => {
    const t: PerCorner<number> = {};
    const hot: PerCorner<number> = {};
    for (const c of CORNERS) {
      if (num(targets[c]) !== undefined) t[c] = num(targets[c]);
      if (num(hotTemps[c]) !== undefined) hot[c] = num(hotTemps[c]);
    }
    if (kindId == null) {
      setError('Pick the tyre first (add it in the garage if it is not listed).');
      return;
    }
    if (!Object.keys(t).length) {
      setError('Enter a target hot pressure for at least one tyre.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPlan(
        await tyres.pressures({
          targets: t,
          hot_c: hot,
          set_c: num(setTemp),
          ambient_c: num(ambient),
          track_c: num(track),
          atmospheric_bar: num(atmos),
          tyre_kind_id: kindId,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyFirst = () => {
    const first = CORNERS.map((c) => targets[c]).find((v) => v.trim());
    if (first) setTargets({ FL: first, FR: first, RL: first, RR: first });
  };

  let no = 3;
  return (
    <Page keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Tyre pressures' }} />
      <Opening title="Tyre pressures"
        dek="The cold pressures to set now so the tyres reach your target hot pressure: by the gas law, and by what your logged runs on this tyre show." />

      <Section no={1} title="Tyre" dek="Different tyres are different pressure models: pick the one on the car.">
        <TyrePicker kinds={kinds} kindId={kindId} onPick={setKindId} notSet={notSet} />
      </Section>

      <Section no={2} title="Conditions now" dek="Ambient and track now, and the tyres’ own temperature where they are set.">
        <FieldGrid columns={wide ? 4 : 2}>
          <Field label="Ambient" unit="°C" value={ambient} onChangeText={setAmbient} placeholder="e.g. 18" />
          <Field label="Track" unit="°C" value={track} onChangeText={setTrack} placeholder="e.g. 30" />
          <Field label="Tyres when set" unit="°C" value={setTemp} onChangeText={setSetTemp}
            placeholder={ambient ? `${ambient} (ambient)` : 'e.g. 22'} />
          <Field label="Air pressure" unit="bar" value={atmos} onChangeText={setAtmos} keyboardType="decimal-pad" />
        </FieldGrid>
      </Section>

      <Section no={3} title="Targets" dek="The hot pressure each tyre should reach, and how hot it will run.">
        <View style={wide ? styles.pair : undefined}>
          <View style={wide ? styles.pairCol : undefined}>
            <SubHead right={<TextLink small label="Same for all" onPress={copyFirst} />}>Target hot pressure, bar</SubHead>
            {kind && (hotTarget?.front != null || hotTarget?.rear != null) ? (
              <Note small>Filled in from the P-Book hot target of {kind.label}; change it for today.</Note>
            ) : null}
            <CarGrid style={styles.grid}
              cell={(c) => (
                <Field
                  value={targets[c]}
                  onChangeText={(v) => setTargets((cur) => ({ ...cur, [c]: v }))}
                  keyboardType="decimal-pad"
                  placeholder="e.g. 1.85"
                  accessibilityLabel={`${c} target hot pressure`}
                />
              )}
            />
          </View>
          <View style={wide ? styles.pairCol : styles.stacked}>
            <SubHead>Expected hot temperature, °C</SubHead>
            <Note small>Optional. Empty uses what the TPMS read when hot in your logged runs.</Note>
            <CarGrid style={styles.grid}
              cell={(c) => (
                <Field
                  value={hotTemps[c]}
                  onChangeText={(v) => setHotTemps((cur) => ({ ...cur, [c]: v }))}
                  placeholder={summary[c]?.median_hot_c != null ? `${Math.round(summary[c]!.median_hot_c!)} (runs)` : '°C'}
                  accessibilityLabel={`${c} expected hot temperature`}
                />
              )}
            />
          </View>
        </View>
        <Actions>
          <MainAction label="Calculate cold pressures" onPress={calculate} busy={busy} disabled={kindId == null} />
        </Actions>
        {error ? <View style={styles.error}><ErrorLine>{error}</ErrorLine></View> : null}
      </Section>

      {plan && <Results no={++no} plan={plan} />}

      {kind && <PBookEditor no={++no} key={kind.id} kind={kind} reference={reference} onSaved={loadKinds} />}

      {kind && <LoggedRuns no={++no} tyre={kind.label} runs={runs} onChanged={loadRuns} />}

      <Colophon left="The Engineer · Tyre pressures" links={[
        { label: 'Tyre temperatures', href: '/tools/tyre-temps' },
        { label: 'Tyre fit', href: '/tools/tyre-fit' },
        { label: 'Garage', href: '/garage' },
      ]} />
    </Page>
  );
}

// The garage's tyres to pick from: different tyres are different pressure models.
function TyrePicker({
  kinds,
  kindId,
  onPick,
  notSet,
}: {
  kinds: TyreKind[] | null;
  kindId: number | null;
  onPick: (id: number) => void;
  notSet: NotSet | null;
}) {
  const styles = useStyles();
  if (kinds == null) return <Working>Reading the garage’s tyres…</Working>;
  return (
    <View style={styles.stack}>
      {kinds.length === 0 && (
        <Note>
          No tyres in the garage yet. Add the tyre you run there (brand and compound): the calculator works per tyre,
          with that tyre’s P-Book pressures and only the runs on it.
        </Note>
      )}
      {kinds.length > 0 && (
        <Options label="Tyre" value={kindId} onPick={onPick}
          options={kinds.map((k) => ({
            value: k.id,
            label: k.label,
            sub: `${k.sessions} session${k.sessions === 1 ? '' : 's'}${k.size ? ` · ${k.size}` : ''}`,
          }))} />
      )}
      <TextLink href="/garage" label="Add a tyre in the garage" arrow small />
      {notSet && notSet.sessions > 0 && kinds.length > 0 && (
        <View style={styles.unset}>
          <Note small>
            {notSet.sessions} session{notSet.sessions === 1 ? ' has' : 's have'} no tyre set, so{' '}
            {notSet.sessions === 1 ? 'its runs are' : 'their runs are'} left out. Set the tyre on the event:
          </Note>
          <View style={styles.links}>
            {notSet.events.map((e) =>
              e.event_id != null ? (
                <TextLink key={e.event_id} small arrow label={eventLabel(e)}
                  href={{ pathname: '/event/[id]', params: { id: e.event_id } }} />
              ) : (
                <Note key="none" small>
                  {e.sessions} session{e.sessions === 1 ? '' : 's'} in no event: put {e.sessions === 1 ? 'it' : 'them'}{' '}
                  in an event first
                </Note>
              ),
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function Results({ no, plan }: { no: number; plan: PressurePlan }) {
  const c = useTheme();
  const styles = useStyles();
  const wide = useWide();
  const by = Object.fromEntries(plan.corners.map((p) => [p.corner, p]));
  return (
    <Section no={no} title="Set these cold"
      dek="The figure is your data’s answer where there are logged runs on this tyre, else the gas law’s.">
      <CarGrid
        cell={(k) => {
          const p = by[k];
          if (!p) return <Text style={styles.dash}>–</Text>;
          const cold = p.data.cold_bar ?? p.gas_law.cold_bar;
          return (
            <View>
              <Fig value={fmt(cold)} unit="bar" size={wide ? 72 : 46} bar={c.tyre.cold} barHeight={6}
                note={`Gas law ${fmt(p.gas_law.cold_bar)} · your data ${fmt(p.data.cold_bar)}${p.data.runs ? ` (${p.data.runs} runs)` : ''}`} />
              {p.flags.length > 0 && (
                <Block label="Below a minimum" color={c.error} ink={inkOn(c.error)} style={styles.flag} />
              )}
            </View>
          );
        }}
      />
      {plan.set_c_source && plan.set_c_source !== 'entered' ? (
        <Note small style={styles.gapTop}>Tyre temperature when set taken as {plan.set_c_source}.</Note>
      ) : null}
      {plan.minimums.message ? <View style={styles.gapTop}><WarnLine>{plan.minimums.message}</WarnLine></View> : null}
      <View style={styles.gapTop}><Ref r={plan.minimums.reference} /></View>

      <SubHead style={styles.subGap}>Corner by corner</SubHead>
      {plan.corners.map((p) => (
        <View key={p.corner} style={styles.why}>
          <View style={styles.whyHead}>
            <Block label={p.corner} color={c.rule} ink={c.background} size={13} />
            <Text style={styles.whyTarget}>Target {p.target_hot_bar.toFixed(2)} bar hot</Text>
          </View>
          {p.flags.map((f) => <ErrorLine key={f}>{f}</ErrorLine>)}
          <View style={wide ? styles.whyCols : undefined}>
            <View style={wide ? styles.whyCol : undefined}>
              <Label small muted>Gas law</Label>
              <Text style={styles.body}>{p.gas_law.text}</Text>
              {p.gas_law.hot_c_source && p.gas_law.hot_c_source !== 'entered' ? (
                <Note small>Hot temperature: {p.gas_law.hot_c_source}.</Note>
              ) : null}
              {p.gas_law.runs_note ? <Note small>{p.gas_law.runs_note}</Note> : null}
            </View>
            <View style={wide ? styles.whyCol : styles.whyNext}>
              <Label small muted>Your logged runs</Label>
              <Text style={styles.body}>{p.data.text}</Text>
            </View>
          </View>
        </View>
      ))}
    </Section>
  );
}

const BOOK_FIELDS = [
  ['cold_min_bar', 'Cold min'],
  ['hot_min_bar', 'Hot min'],
  ['hot_target_bar', 'Hot target'],
] as const;

// The tyre's P-Book pressures, kept with the tyre: the minimums the answers are checked against and the hot targets
// the targets above start from.
function PBookEditor({ no, kind, reference, onSaved }: { no: number; kind: TyreKind; reference: Reference | null;
  onSaved: () => void }) {
  const styles = useStyles();
  const t = useTableStyles();
  const book = kind.pbook;
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = { source: book.source ?? '' };
    for (const [key] of BOOK_FIELDS)
      for (const axle of ['front', 'rear'] as const) {
        const x = book[key][axle];
        v[`${axle}-${key}`] = x != null ? String(x) : '';
      }
    return v;
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    const pair = (key: string) => {
      const out: Record<'front' | 'rear', number | null> = { front: null, rear: null };
      for (const axle of ['front', 'rear'] as const) {
        const raw = vals[`${axle}-${key}`] ?? '';
        const x = num(raw);
        if (raw.trim() && (x === undefined || x <= 0 || x >= 10)) throw new Error('Pressures are in bar, e.g. 1.40');
        out[axle] = x ?? null;
      }
      return out;
    };
    setSaving(true);
    setMsg(null);
    try {
      await toolLists.saveTyreBook(kind, {
        cold_min_bar: pair('cold_min_bar'),
        hot_min_bar: pair('hot_min_bar'),
        hot_target_bar: pair('hot_target_bar'),
        source: vals.source.trim() || null,
      });
      setMsg('Saved with the tyre.');
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const set = (k: string) => (v: string) => setVals((cur) => ({ ...cur, [k]: v }));
  return (
    <Section no={no} title="P-Book pressures" dek={`${kind.label}, in bar: the minimums every answer is checked against, and the hot targets that fill in the targets above.`}>
      {book.origin === null && (
        <View style={styles.gapBottom}>
          <WarnLine>
            Not entered yet. The P-Book is issued to teams and is not public: enter the minimums and hot targets from
            your copy, and they stay with this tyre.
          </WarnLine>
        </View>
      )}
      {book.origin === 'series' && (
        <Note small style={styles.gapBottom}>
          From the minimums entered for {(book.series ?? []).join(', ')} before tyres had their own. Save to keep them
          with this tyre.
        </Note>
      )}
      <View style={styles.book}>
        <View style={t.head}>
          <Text style={StyleSheet.flatten([t.th, styles.axleCol])}>Axle</Text>
          {BOOK_FIELDS.map(([key, label]) => (
            <Text key={key} style={StyleSheet.flatten([t.th, styles.bookCol])}>{label}</Text>
          ))}
        </View>
        {(['front', 'rear'] as const).map((axle) => (
          <View key={axle} style={t.row}>
            <Text style={StyleSheet.flatten([t.name, styles.axleCol])}>{axle === 'front' ? 'Front' : 'Rear'}</Text>
            {BOOK_FIELDS.map(([key, label]) => (
              <View key={key} style={styles.bookCol}>
                <Field small value={vals[`${axle}-${key}`] ?? ''} onChangeText={set(`${axle}-${key}`)}
                  keyboardType="decimal-pad" placeholder="–" accessibilityLabel={`${axle} ${label}`} />
              </View>
            ))}
          </View>
        ))}
      </View>
      <View style={styles.source}>
        <Field label="Source" value={vals.source ?? ''} onChangeText={set('source')} keyboardType="default"
          placeholder="P-Book edition and page" />
      </View>
      <Actions>
        <TextLink onPress={save} disabled={saving} label={saving ? 'Saving…' : `Save to ${kind.label}`} red />
        {msg ? <Note small>{msg}</Note> : null}
      </Actions>
      {reference ? <View style={styles.gapTop}><Ref r={reference} /></View> : null}
    </Section>
  );
}

function LoggedRuns({ no, tyre, runs, onChanged }: { no: number; tyre: string; runs: LoggedRun[] | null;
  onChanged: () => void }) {
  const styles = useStyles();
  const wide = useWide();
  const t = useTableStyles();
  const [tracks, setTracks] = useState<Record<number, string>>({});
  const saveTrack = async (sessionId: number) => {
    const v = tracks[sessionId];
    if (v === undefined) return;
    await tyres.setConditions(sessionId, { track_temp_c: num(v) ?? null }).catch(() => {});
    onChanged();
  };
  return (
    <Section no={no} title={`Logged runs${runs ? ` · ${runs.length}` : ''}`}
      dek={`The runs on ${tyre} the calculator learns from.`}>
      <Note small>
        Only the sessions whose event ran this tyre. Cold is where each TPMS sensor first reported after the car
        rolled; hot is where the pressure settled after 12 minutes at speed. Enter a session’s track temperature so
        the model can learn its effect.
      </Note>
      {runs == null && <Working>Reading the logs…</Working>}
      {runs?.length === 0 && (
        <Note small style={styles.gapTop}>
          No logged run on this tyre yet: set the tyre on your events, and upload MoTeC logs with TPMS channels.
        </Note>
      )}
      <View style={wide ? styles.runsWide : undefined}>
      {runs?.map((r) => (
        <View key={`${r.file_id}-${r.set}`} style={wide ? styles.runWide : styles.run}>
          <SubHead>
            {r.session}
            {r.set > 0 ? ` · tyre set ${r.set + 1}, fitted at ${Math.round(r.start_s / 60)} min` : ''}
          </SubHead>
          <View style={styles.runMeta}>
            <View style={styles.runWhat}>
              <Text style={styles.file} numberOfLines={1}>{r.file}</Text>
              <Text style={styles.ambient}>
                Ambient {fmt(r.ambient_c, 1)} °C{r.ambient_source ? ` (${r.ambient_source})` : ''}
              </Text>
            </View>
            <Field label="Track" unit="°C" small width={70} align="right"
              value={tracks[r.session_id] ?? (r.track_c != null ? String(r.track_c) : '')}
              onChangeText={(v) => setTracks((cur) => ({ ...cur, [r.session_id]: v }))}
              onBlur={() => saveTrack(r.session_id)} placeholder="–" />
          </View>
          <View style={t.head}>
            <Text style={StyleSheet.flatten([t.th, styles.cornerCol])}>Tyre</Text>
            {['Cold bar', 'Hot bar', 'Rise', 'Cold °C', 'Hot °C'].map((h) => (
              <Text key={h} style={StyleSheet.flatten([t.th, t.num, styles.numCol])}>{h}</Text>
            ))}
          </View>
          {CORNERS.map((c) => {
            const x = r.corners[c];
            if (!x) return null;
            const td = StyleSheet.flatten([t.td, t.num, styles.numCol, !x.used && t.muted]);
            return (
              <View key={c} style={styles.runRow}>
                <View style={styles.runCells}>
                  <Text style={StyleSheet.flatten([t.name, styles.cornerCol, !x.used && t.muted])}>{c}</Text>
                  <Text style={td}>{fmt(x.cold_bar)}</Text>
                  <Text style={td}>{fmt(x.hot_bar)}</Text>
                  <Text style={td}>{x.rise_bar != null ? `+${fmt(x.rise_bar)}` : '–'}</Text>
                  <Text style={td}>{fmt(x.cold_c, 0)}</Text>
                  <Text style={td}>{fmt(x.hot_c, 0)}</Text>
                </View>
                {x.note ? <Text style={styles.runNote}>{x.note}</Text> : null}
              </View>
            );
          })}
        </View>
      ))}
      </View>
    </Section>
  );
}

const useStyles = themed((c) => ({
  stack: { gap: 14 },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 8, marginTop: 6 },
  unset: { borderTopWidth: 1, borderColor: c.separator, paddingTop: 10 },
  pair: { flexDirection: 'row', gap: 36 },
  pairCol: { flex: 1, minWidth: 0 },
  stacked: { marginTop: 26 },
  grid: { marginTop: 8 },
  error: { marginTop: 12 },
  dash: { fontFamily: Fonts.display, fontSize: 40, color: c.textMuted },
  flag: { marginTop: 10 },
  gapTop: { marginTop: 12 },
  gapBottom: { marginBottom: 12 },
  subGap: { marginTop: 28 },
  why: { borderBottomWidth: 1, borderColor: c.separator, paddingTop: 10, paddingBottom: 12, gap: 6 },
  whyHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  whyTarget: { ...Type.label, fontSize: 13, color: c.text },
  whyCols: { flexDirection: 'row', gap: 28 },
  whyCol: { flex: 1, minWidth: 0, gap: 3 },
  whyNext: { marginTop: 8, gap: 3 },
  body: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text },
  book: { maxWidth: 560 },
  axleCol: { width: 64 },
  bookCol: { flex: 1, minWidth: 0, paddingRight: 14 },
  source: { maxWidth: 560, marginTop: 18 },
  run: { marginTop: 22 },
  runsWide: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  runWide: { marginTop: 26, width: '48%' },
  runMeta: { flexDirection: 'row', alignItems: 'flex-end', gap: 16, marginBottom: 12 },
  runWhat: { flex: 1, minWidth: 0 },
  file: { fontFamily: Fonts.label, fontSize: 13, color: c.textMuted },
  ambient: { fontFamily: Fonts.label, fontSize: 15, fontVariant: ['tabular-nums'], color: c.text, marginTop: 2 },
  runRow: { borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 6 },
  runCells: { flexDirection: 'row', alignItems: 'center' },
  runNote: { fontFamily: Type.dek.fontFamily, fontSize: 13, lineHeight: 18, color: c.textSecondary, marginTop: 2,
    marginLeft: 40 },
  cornerCol: { width: 40 },
  numCol: { flex: 1, minWidth: 0 },
}));
