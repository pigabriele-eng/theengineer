// The tyre model built from every log of a car: what the data say first (where the peak sits, which pressure and
// temperature give the most grip, how sure), then the curve, grip against each condition and the sessions it rests
// on. Logs are summarised in the background; this view follows that and refits as summaries come in. It draws
// numbered sections of the Tyre fit page, from `from`.
import { useFocusEffect } from 'expo-router';
import { ReactNode, useCallback, useEffect, useState } from 'react';

import { GripByCondition } from '@/components/GripByCondition';
import { Fig, Label, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { ErrorLine, Field, Note, Options, SubHead, Working } from '@/components/ToolForm';
import { AxleCard, CurveChart, useAxleColors } from '@/components/TyreCurve';
import { eventLabel } from '@/lib/toolLists';
import {
  Axle,
  AXLES,
  ConditionKey,
  gripNum,
  GripWindow,
  ModelCar,
  ModelSession,
  NOT_SET,
  SummaryStatus,
  TyreModel,
  tyreModelApi,
  TyreNotSet,
} from '@/lib/tyreModel';
import { Fonts, themed, Type } from '@/constants/Theme';

const CONDITIONS: { key: ConditionKey; title: string }[] = [
  { key: 'pressure', title: 'Hot pressure' },
  { key: 'temperature', title: 'TPMS temperature' },
  { key: 'tyre_laps', title: 'Laps on the tyre' },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const POLL_MS = 5000;
const ALL = '\u0000all'; // the "All tracks" option (no track has this name)

export function TyreModelView({ from = 1 }: { from?: number }) {
  const styles = useStyles();
  const wide = useWide();
  const [cars, setCars] = useState<ModelCar[] | null>(null);
  const [status, setStatus] = useState<SummaryStatus | null>(null);
  const [car, setCar] = useState<string | null>(null);
  const [tyreKind, setTyreKind] = useState<number | typeof NOT_SET | null>(null); // null: the car's most used
  const [track, setTrack] = useState<string | null>(null);
  const [ambientText, setAmbientText] = useState({ min: '', max: '' });
  const [ambient, setAmbient] = useState<{ min: number | null; max: number | null }>({ min: null, max: null });
  const [model, setModel] = useState<TyreModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const loadCars = useCallback(async () => {
    const r = await tyreModelApi.cars();
    setCars(r.cars);
    setStatus(r.status);
    setCar((c) => (c && r.cars.some((x) => x.key === c) ? c : (r.cars[0]?.key ?? null)));
  }, []);

  // the tyre on view may have no session left (its events set to another tyre): back to the car's most used
  const carTyres = cars?.find((x) => x.key === car)?.tyres;
  useEffect(() => {
    if (carTyres && tyreKind != null && !carTyres.some((t) => (t.id ?? NOT_SET) === tyreKind)) setTyreKind(null);
  }, [carTyres, tyreKind]);

  // again on coming back: a tyre set on an event moves its sessions to that tyre's model
  useFocusEffect(
    useCallback(() => {
      loadCars().catch((e) => setError(e.message));
      setReload((r) => r + 1);
    }, [loadCars]),
  );

  // older logs are summarised in the background: follow it while it works
  const working = !!status && (status.pending > 0 || status.running);
  useEffect(() => {
    if (!working) return;
    const t = setTimeout(() => loadCars().catch(() => {}), POLL_MS);
    return () => clearTimeout(t);
  }, [working, status, loadCars]);

  const summarised = status?.summarised;
  useEffect(() => {
    if (!car) return;
    let live = true;
    setBusy(true);
    setError(null);
    tyreModelApi
      .model({ car, tyreKind, track, ambient_min: ambient.min, ambient_max: ambient.max })
      .then(
        (m) => live && setModel(m),
        (e) => {
          if (!live) return;
          setModel(null);
          setError(e.message);
        },
      )
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [car, tyreKind, track, ambient, summarised, reload]);

  const applyAmbient = () => {
    const parse = (s: string) => (s.trim() ? Number(s.replace(',', '.')) : null);
    const min = parse(ambientText.min);
    const max = parse(ambientText.max);
    if ((min != null && !Number.isFinite(min)) || (max != null && !Number.isFinite(max))) {
      setError('Ambient temperatures must be numbers');
      return;
    }
    setAmbient({ min, max });
  };

  const current = cars?.find((c) => c.key === car) ?? null;
  const dek = 'One tyre model from every session of the car on this tyre: different tyres are different models, and a session’s tyre is the one set on its event.';

  if (cars && cars.length === 0) {
    return (
      <Section no={from} title="The data" dek={dek}>
        <StatusLine status={status} />
        <Note>
          No log has been summarised for the tyre model yet. Upload or import logs: each is summarised in the
          background, one at a time, and the model grows with every session.
        </Note>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
      </Section>
    );
  }

  const tyreOn = model ? (model.tyre_kind?.id ?? NOT_SET) : tyreKind;
  return (
    <>
      <Section no={from} title="The data" dek={dek}>
        <StatusLine status={status} />
        {!cars && <Working>Reading the cars…</Working>}
        {current && (
          <View style={styles.filters}>
            {cars && cars.length > 1 ? (
              <Filter label="Car">
                <Options label="Car" value={car}
                  onPick={(k) => {
                    setCar(k);
                    setTyreKind(null);
                    setTrack(null);
                  }}
                  options={cars.map((c) => ({ value: c.key, label: c.label, sub: `${c.sessions} sessions` }))} />
              </Filter>
            ) : (
              <Filter label="Car"><Text style={styles.carName}>{current.label}</Text></Filter>
            )}
            <Filter label="Tyre" sub="One model per tyre">
              <Options<number | string> label="Tyre" value={tyreOn} onPick={(v) => setTyreKind(v as number | typeof NOT_SET)}
                options={current.tyres.map((t) => ({
                  value: t.id ?? NOT_SET,
                  label: t.name,
                  sub: `${t.sessions} session${t.sessions === 1 ? '' : 's'}`,
                  muted: t.id == null,
                }))} />
              {current.not_set.sessions > 0 && <SetOnEvent notSet={current.not_set} />}
            </Filter>
            {current.tracks.length > 0 && (
              <Filter label="Track">
                <Options label="Track" value={track ?? ALL} onPick={(v) => setTrack(v === ALL ? null : v)}
                  options={[
                    { value: ALL, label: 'All tracks' },
                    ...current.tracks.map((t) => ({ value: t.name, label: t.name, sub: `${t.sessions} sessions` })),
                  ]} />
              </Filter>
            )}
            <Filter label="Ambient" sub="°C">
              <View style={styles.ambient}>
                <Field small width={wide ? 80 : 70} align="right" value={ambientText.min}
                  onChangeText={(v) => setAmbientText((a) => ({ ...a, min: v }))} placeholder="from"
                  accessibilityLabel="Ambient from, °C" onSubmitEditing={applyAmbient} />
                <Text style={styles.to}>to</Text>
                <Field small width={wide ? 80 : 70} align="right" value={ambientText.max}
                  onChangeText={(v) => setAmbientText((a) => ({ ...a, max: v }))} placeholder="to"
                  accessibilityLabel="Ambient to, °C" onSubmitEditing={applyAmbient} />
                <TextLink small onPress={applyAmbient} label="Apply" />
                {(ambient.min != null || ambient.max != null) && (
                  <TextLink small label="Any"
                    onPress={() => {
                      setAmbientText({ min: '', max: '' });
                      setAmbient({ min: null, max: null });
                    }} />
                )}
              </View>
            </Filter>
          </View>
        )}
        {busy && !model && <Working>Fitting the model…</Working>}
        {error ? <View style={styles.gapTop}><ErrorLine>{error}</ErrorLine></View> : null}
      </Section>
      {model && <ModelResult model={model} busy={busy} from={from + 1} />}
    </>
  );
}

// Sessions whose event names no tyre count for no tyre's model: where to set it.
function SetOnEvent({ notSet }: { notSet: TyreNotSet }) {
  const styles = useStyles();
  const n = notSet.sessions;
  return (
    <View style={styles.prompt}>
      <Note small>
        {n} session{n === 1 ? '' : 's'} of this car {n === 1 ? 'has' : 'have'} no tyre set, so{' '}
        {n === 1 ? 'it is' : 'they are'} pooled apart as “Tyre not set”. Set the tyre on the event and{' '}
        {n === 1 ? 'it joins' : 'they join'} that tyre’s model:
      </Note>
      <View style={styles.links}>
        {notSet.events.map((e) =>
          e.event_id != null ? (
            <TextLink key={e.event_id} small arrow label={eventLabel(e)}
              href={{ pathname: '/event/[id]', params: { id: e.event_id } }} />
          ) : (
            <Note key="none" small>
              {eventLabel(e)} (put {e.sessions === 1 ? 'it' : 'them'} in an event first)
            </Note>
          ),
        )}
      </View>
    </View>
  );
}

/** A filter: its label in Archivo capitals on the left (above on a phone), its options beside it. */
function Filter({ label, sub, children }: { label: string; sub?: string; children: ReactNode }) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={wide ? styles.filter : styles.filterPhone}>
      <View style={wide ? styles.filterName : styles.filterNamePhone}>
        <Label small>{label}</Label>
        {sub ? <Text style={styles.filterSub}>{sub}</Text> : null}
      </View>
      <View style={styles.filterBody}>{children}</View>
    </View>
  );
}

function StatusLine({ status }: { status: SummaryStatus | null }) {
  if (!status) return null;
  const parts = [`${status.summarised} log${status.summarised === 1 ? '' : 's'} in the model`];
  if (status.without_cornering) parts.push(`${status.without_cornering} without steady cornering`);
  if (status.failed) parts.push(`${status.failed} unreadable`);
  const working = status.pending > 0 || status.running;
  const line = `${parts.join(', ')}${working
    ? `; summarising ${status.pending || 1} more in the background, one at a time. The model updates as they come in.`
    : '.'}`;
  return working ? <Working>{line}</Working> : <Note small>{line}</Note>;
}

function basisLine(m: TyreModel) {
  const b = m.basis;
  let s =
    `${b.sessions} session${b.sessions === 1 ? '' : 's'}, ${b.laps} laps, ${b.samples.toLocaleString()} samples of ` +
    `steady cornering in ${b.corners} corners`;
  if (b.tracks.length) s += ` at ${b.tracks.join(', ')}`;
  if (b.dates.length) s += `, ${b.dates[0] === b.dates[1] ? day(b.dates[0]) : `${day(b.dates[0])} to ${day(b.dates[1])}`}`;
  if (b.ambient_c) s += `, ambient ${b.ambient_c[0]}${b.ambient_c[1] !== b.ambient_c[0] ? `–${b.ambient_c[1]}` : ''} °C`;
  s += `, ${b.speed_range_kmh[0]}–${b.speed_range_kmh[1]} km/h.`;
  s += ` TPMS on ${b.with_tpms} of the laps; laps on the tyre known for ${b.with_tyre_laps}.`;
  return s;
}

/** "Front: most grip at ..." with the axle in Archivo capitals. */
function Said({ text }: { text: string }) {
  const styles = useStyles();
  const i = text.indexOf(': ');
  return (
    <Text style={styles.said}>
      {i > 0 ? <Text style={styles.saidAxle}>{`${text.slice(0, i)}  `}</Text> : null}
      {i > 0 ? text.slice(i + 2) : text}
    </Text>
  );
}

function windowText(axle: string, w: GripWindow | null) {
  return w?.text ?? `${axle === 'front' ? 'Front' : 'Rear'}: not enough laps from three sessions or more to compare yet.`;
}

/** A window the data hold to (high or medium confidence) with the grip it gains. */
const confident = (w: GripWindow | null): w is GripWindow & { gain: number } =>
  !!w && w.gain != null && (w.confidence === 'high' || w.confidence === 'medium');

/** The two axles side by side (one above the other on a phone). */
function Axles({ children }: { children: (a: Axle) => ReactNode }) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={wide ? styles.axles : styles.axlesPhone}>
      {AXLES.map((a) => <View key={a} style={wide ? styles.axleCol : undefined}>{children(a)}</View>)}
    </View>
  );
}

function ModelResult({ model, busy, from }: { model: TyreModel; busy: boolean; from: number }) {
  const styles = useStyles();
  const wide = useWide();
  const colors = useAxleColors();
  const [cond, setCond] = useState<ConditionKey>('pressure');
  const c = model.conditions[cond];
  return (
    <View style={busy ? styles.stale : undefined}>
      <Section no={from} title="What the data say"
        dek={`${model.tyre_kind ? model.tyre : 'Tyre not set: sessions whose event names no tyre'}.`}>
        <Note small>{basisLine(model)}</Note>
        <SubHead style={styles.subGap}>Where the peak sits</SubHead>
        <Axles>{(a) => <Said text={model.axles[a].advice} />}</Axles>
        {CONDITIONS.map((k) => (
          <View key={k.key}>
            <SubHead style={styles.subGap}>{k.title}</SubHead>
            <Axles>
              {(a) => {
                const w = model.conditions[k.key][a].window;
                return (
                  <View style={styles.saidBlock}>
                    {confident(w) && (
                      <Fig label={`${a === 'front' ? 'Front' : 'Rear'}: most grip · ${w.confidence} confidence`}
                        value={gripNum(w.gain, 0)} unit="%" size={wide ? 56 : 48} bar={colors[a]} barHeight={6} />
                    )}
                    <Said text={windowText(a, w)} />
                  </View>
                );
              }}
            </Axles>
          </View>
        ))}
      </Section>

      <Section no={from + 1} title="Grip curve" dek="Grip against slip angle per axle: where it peaks, and how sharply.">
        <CurveChart curves={model.curves} binned={model.binned} fits={model.axles} />
        <View style={wide ? styles.cards : styles.cardsPhone}>
          <AxleCard title="Front axle" f={model.axles.front} color={colors.front} />
          <AxleCard title="Rear axle" f={model.axles.rear} color={colors.rear} />
        </View>
      </Section>

      <Section no={from + 2} title="Grip against conditions"
        dek="Each group’s grip at the same slip angle against the average lap, one panel per axle on the same scale.">
        <Options label="Condition" value={cond} onPick={setCond}
          options={CONDITIONS.map((k) => ({ value: k.key, label: k.title }))} />
        <View style={styles.condChart}>
          <GripByCondition cond={c} condKey={cond} />
        </View>
        <Note small style={styles.gapTop}>{c.note}</Note>
      </Section>

      <Section no={from + 3} title="Sessions in the model"
        dek="Slip shift: how far each session’s slip angles were moved to line up with the others at low grip.">
        <Sessions sessions={model.sessions} />
        <SubHead style={styles.subGap}>How it is estimated</SubHead>
        {model.assumptions.map((a) => (
          <Text key={a} style={styles.assumption}>{a}</Text>
        ))}
      </Section>
    </View>
  );
}

function Sessions({ sessions }: { sessions: ModelSession[] }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const shown = open ? sessions : sessions.slice(0, 4);
  return (
    <View>
      <View style={styles.sessionsTop} />
      {shown.map((s) => (
        <SessionRow key={`${s.session_id}-${s.name}`} s={s} />
      ))}
      {sessions.length > 4 && (
        <View style={styles.more}>
          <TextLink small onPress={() => setOpen((o) => !o)} label={open ? 'Show fewer' : `Show all ${sessions.length}`} />
        </View>
      )}
    </View>
  );
}

function SessionRow({ s }: { s: ModelSession }) {
  const styles = useStyles();
  const wide = useWide();
  const shift = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}°`;
  return (
    <View style={wide ? styles.sessionRow : styles.sessionRowPhone}>
      <View style={wide ? styles.sessionName : undefined}>
        <Text style={styles.sessionTitle} numberOfLines={1}>{s.name}</Text>
        <Text style={styles.sessionMeta}>
          {[s.date && day(s.date), s.track, s.ambient_c != null && `${s.ambient_c} °C`].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <View style={wide ? styles.sessionNums : undefined}>
        <Text style={styles.sessionNum}>{s.laps} laps · {s.samples.toLocaleString()} samples</Text>
        <Text style={styles.sessionNum}>
          Slip shift front {shift(s.slip_shift_deg.front)}, rear {shift(s.slip_shift_deg.rear)}
        </Text>
      </View>
      <View style={wide ? styles.sessionTyre : styles.sessionTyrePhone}>
        <Text style={styles.sessionMeta}>Tyre: {s.tyre ?? '–'}</Text>
        {s.event_id != null ? (
          <TextLink small label="Set on the event" href={{ pathname: '/event/[id]', params: { id: s.event_id } }} />
        ) : null}
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  filters: { borderTopWidth: 1, borderColor: c.rule, marginTop: 14 },
  filter: { flexDirection: 'row', gap: 20, borderBottomWidth: 1, borderColor: c.separator, paddingTop: 12, paddingBottom: 14 },
  filterPhone: { gap: 8, borderBottomWidth: 1, borderColor: c.separator, paddingTop: 10, paddingBottom: 12 },
  filterName: { width: 150 },
  filterNamePhone: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  filterSub: { fontFamily: Fonts.body, fontSize: 13, lineHeight: 18, color: c.textMuted },
  filterBody: { flex: 1, minWidth: 0, gap: 10 },
  carName: { fontFamily: Fonts.label, fontSize: 16, color: c.text },
  ambient: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', columnGap: 12, rowGap: 10 },
  to: { fontFamily: Fonts.body, fontSize: 15, color: c.textSecondary, paddingBottom: 5 },
  prompt: { gap: 6, marginTop: 4 },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 8 },
  gapTop: { marginTop: 12 },
  subGap: { marginTop: 26 },
  stale: { opacity: 0.6 },
  said: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text },
  saidAxle: { ...Type.label, fontSize: 13, color: c.text },
  saidBlock: { gap: 10 },
  axles: { flexDirection: 'row', gap: 32, marginTop: 4 },
  axlesPhone: { gap: 12, marginTop: 4 },
  axleCol: { flex: 1, minWidth: 0 },
  cards: { flexDirection: 'row', gap: 32, marginTop: 24 },
  cardsPhone: { gap: 26, marginTop: 24 },
  condChart: { marginTop: 18 },
  assumption: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: c.textSecondary, borderBottomWidth: 1,
    borderColor: c.separator, paddingVertical: 6 },
  sessionsTop: { height: 2, backgroundColor: c.rule },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: 20, borderBottomWidth: 1, borderColor: c.separator,
    paddingVertical: 9 },
  sessionRowPhone: { gap: 4, borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 9 },
  sessionName: { width: 260 },
  sessionTitle: { fontFamily: Type.label.fontFamily, fontSize: 16, color: c.text },
  sessionMeta: { fontFamily: Fonts.label, fontSize: 13, color: c.textSecondary },
  sessionNums: { flex: 1, minWidth: 0 },
  sessionNum: { fontFamily: Fonts.label, fontSize: 14, fontVariant: ['tabular-nums'], color: c.text },
  sessionTyre: { width: 200, alignItems: 'flex-end', gap: 4 },
  sessionTyrePhone: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 4, marginTop: 2 },
  more: { marginTop: 12 },
}));
