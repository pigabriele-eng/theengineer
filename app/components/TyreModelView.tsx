// The tyre model built from every log of a car: what the data say first (where the peak sits, which pressure and
// temperature give the most grip, how sure), then the curve, grip against each condition and the sessions it rests
// on. Logs are summarised in the background; this view follows that and refits as summaries come in.
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { GripByCondition } from '@/components/GripByCondition';
import { Text, View, useThemeColor } from '@/components/Themed';
import { AxleCard, CurveChart, useAxleColors } from '@/components/TyreCurve';
import { eventLabel } from '@/lib/toolLists';
import {
  AXLES,
  ConditionKey,
  GripWindow,
  ModelCar,
  ModelSession,
  NOT_SET,
  SummaryStatus,
  TyreModel,
  tyreModelApi,
  TyreNotSet,
} from '@/lib/tyreModel';

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

export function TyreModelView() {
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
  const text = useThemeColor({}, 'text');
  const tint = useThemeColor({}, 'tint');

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
  const chip = (on: boolean) => (on ? [styles.chip, { borderColor: tint }] : styles.chip);

  if (cars && cars.length === 0) {
    return (
      <View style={styles.section}>
        <StatusLine status={status} />
        <Text style={styles.sub}>
          No log has been summarised for the tyre model yet. Upload or import logs: each is summarised in the
          background, one at a time, and the model grows with every session.
        </Text>
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <StatusLine status={status} />

      {current && (
        <View style={styles.section}>
          {cars && cars.length > 1 ? (
            <View style={styles.chips}>
              {cars.map((c) => (
                <Pressable
                  key={c.key}
                  style={chip(c.key === car)}
                  onPress={() => {
                    setCar(c.key);
                    setTyreKind(null);
                    setTrack(null);
                  }}>
                  <Text style={c.key === car ? { color: tint } : undefined}>
                    {c.label} · {c.sessions}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <Text style={styles.h2}>{current.label}</Text>
          )}
          <Filter label="Tyre (one model per tyre)">
            {current.tyres.map((t) => {
              const key = t.id ?? NOT_SET;
              const on = (model ? (model.tyre_kind?.id ?? NOT_SET) : tyreKind) === key;
              return (
                <Pressable key={key} style={chip(on)} onPress={() => setTyreKind(key)}>
                  <Text style={on ? { color: tint } : t.id == null ? styles.dimText : undefined}>
                    {t.name} · {t.sessions}
                  </Text>
                </Pressable>
              );
            })}
          </Filter>
          {current.not_set.sessions > 0 && <SetOnEvent notSet={current.not_set} />}
          {current.tracks.length > 0 && (
            <Filter label="Track">
              <Pressable style={chip(track == null)} onPress={() => setTrack(null)}>
                <Text style={track == null ? { color: tint } : undefined}>All tracks</Text>
              </Pressable>
              {current.tracks.map((t) => (
                <Pressable key={t.name} style={chip(track === t.name)} onPress={() => setTrack(t.name)}>
                  <Text style={track === t.name ? { color: tint } : undefined}>
                    {t.name} · {t.sessions}
                  </Text>
                </Pressable>
              ))}
            </Filter>
          )}
          <Filter label="Ambient °C">
            <TextInput
              style={[styles.input, { color: text }]}
              value={ambientText.min}
              onChangeText={(v) => setAmbientText((a) => ({ ...a, min: v }))}
              placeholder="from"
              placeholderTextColor="#8888"
              keyboardType="numbers-and-punctuation"
              onSubmitEditing={applyAmbient}
            />
            <TextInput
              style={[styles.input, { color: text }]}
              value={ambientText.max}
              onChangeText={(v) => setAmbientText((a) => ({ ...a, max: v }))}
              placeholder="to"
              placeholderTextColor="#8888"
              keyboardType="numbers-and-punctuation"
              onSubmitEditing={applyAmbient}
            />
            <Pressable style={styles.chip} onPress={applyAmbient}>
              <Text>Apply</Text>
            </Pressable>
            {(ambient.min != null || ambient.max != null) && (
              <Pressable
                style={styles.chip}
                onPress={() => {
                  setAmbientText({ min: '', max: '' });
                  setAmbient({ min: null, max: null });
                }}>
                <Text>Any</Text>
              </Pressable>
            )}
          </Filter>
        </View>
      )}

      {busy && !model && <ActivityIndicator />}
      {error && <Text style={styles.error}>{error}</Text>}
      {model && <ModelResult model={model} busy={busy} />}
    </View>
  );
}

// Sessions whose event names no tyre count for no tyre's model: where to set it.
function SetOnEvent({ notSet }: { notSet: TyreNotSet }) {
  const router = useRouter();
  const tint = useThemeColor({}, 'tint');
  const n = notSet.sessions;
  return (
    <View style={styles.prompt}>
      <Text style={styles.note}>
        {n} session{n === 1 ? '' : 's'} of this car {n === 1 ? 'has' : 'have'} no tyre set, so{' '}
        {n === 1 ? 'it is' : 'they are'} pooled apart as "Tyre not set". Set the tyre on the event and{' '}
        {n === 1 ? 'it joins' : 'they join'} that tyre's model:
      </Text>
      <View style={styles.chips}>
        {notSet.events.map((e) =>
          e.event_id != null ? (
            <Pressable
              key={e.event_id}
              onPress={() => router.push({ pathname: '/event/[id]', params: { id: e.event_id! } })}
              accessibilityRole="link">
              <Text style={[styles.linkText, { color: tint }]}>{eventLabel(e)}</Text>
            </Pressable>
          ) : (
            <Text key="none" style={styles.note}>
              {eventLabel(e)} (put {e.sessions === 1 ? 'it' : 'them'} in an event first)
            </Text>
          ),
        )}
      </View>
    </View>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.filter}>
      <Text style={styles.filterLabel}>{label}</Text>
      <View style={styles.chips}>{children}</View>
    </View>
  );
}

function StatusLine({ status }: { status: SummaryStatus | null }) {
  if (!status) return null;
  const parts = [`${status.summarised} log${status.summarised === 1 ? '' : 's'} in the model`];
  if (status.without_cornering) parts.push(`${status.without_cornering} without steady cornering`);
  if (status.failed) parts.push(`${status.failed} unreadable`);
  const working = status.pending > 0 || status.running;
  return (
    <View style={styles.statusRow}>
      {working && <ActivityIndicator size="small" />}
      <Text style={styles.note}>
        {parts.join(', ')}
        {working
          ? `; summarising ${status.pending || 1} more in the background, one at a time. The model updates as they come in.`
          : '.'}
      </Text>
    </View>
  );
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

/** "Front: most grip at ..." with the axle in bold. */
function Said({ text }: { text: string }) {
  const i = text.indexOf(': ');
  return (
    <Text style={styles.said}>
      <Text style={styles.bold}>{i > 0 ? text.slice(0, i + 1) : ''}</Text>
      {i > 0 ? text.slice(i + 1) : text}
    </Text>
  );
}

function windowText(axle: string, w: GripWindow | null) {
  return w?.text ?? `${axle === 'front' ? 'Front' : 'Rear'}: not enough laps from three sessions or more to compare yet.`;
}

function ModelResult({ model, busy }: { model: TyreModel; busy: boolean }) {
  const colors = useAxleColors();
  const [cond, setCond] = useState<ConditionKey>('pressure');
  const tint = useThemeColor({}, 'tint');
  const c = model.conditions[cond];
  return (
    <View style={[styles.wrap, busy && { opacity: 0.6 }]}>
      <View style={styles.advice}>
        <Text style={styles.h2}>What the data say</Text>
        <Text style={styles.sub}>
          {model.tyre_kind ? model.tyre : 'Tyre not set: sessions whose event names no tyre'}. {basisLine(model)}
        </Text>
        <Text style={styles.subhead}>Where the peak sits</Text>
        {AXLES.map((a) => (
          <Said key={a} text={model.axles[a].advice} />
        ))}
        {CONDITIONS.map((k) => (
          <View key={k.key} style={styles.adviceBlock}>
            <Text style={styles.subhead}>{k.title}</Text>
            {AXLES.map((a) => (
              <Said key={a} text={windowText(a, model.conditions[k.key][a].window)} />
            ))}
          </View>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.h2}>Grip curve</Text>
        <CurveChart curves={model.curves} binned={model.binned} fits={model.axles} />
        <AxleCard title="Front axle" f={model.axles.front} color={colors.front} />
        <AxleCard title="Rear axle" f={model.axles.rear} color={colors.rear} />
      </View>

      <View style={styles.section}>
        <Text style={styles.h2}>Grip against conditions</Text>
        <View style={styles.chips}>
          {CONDITIONS.map((k) => {
            const on = k.key === cond;
            return (
              <Pressable key={k.key} style={on ? [styles.chip, { borderColor: tint }] : styles.chip} onPress={() => setCond(k.key)}>
                <Text style={on ? { color: tint } : undefined}>{k.title}</Text>
              </Pressable>
            );
          })}
        </View>
        <GripByCondition cond={c} condKey={cond} />
        <Text style={styles.note}>{c.note}</Text>
      </View>

      <Sessions sessions={model.sessions} />

      <View style={styles.section}>
        <Text style={styles.subhead}>How it is estimated</Text>
        {model.assumptions.map((a) => (
          <Text key={a} style={styles.note}>
            · {a}
          </Text>
        ))}
      </View>
    </View>
  );
}

function Sessions({ sessions }: { sessions: ModelSession[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? sessions : sessions.slice(0, 4);
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Sessions in the model</Text>
      <Text style={styles.note}>
        Slip shift: how far each session's slip angles were moved to line up with the others at low grip.
      </Text>
      {shown.map((s) => (
        <SessionRow key={`${s.session_id}-${s.name}`} s={s} />
      ))}
      {sessions.length > 4 && (
        <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button">
          <Text style={styles.link}>{open ? 'Show fewer' : `Show all ${sessions.length}`}</Text>
        </Pressable>
      )}
    </View>
  );
}

function SessionRow({ s }: { s: ModelSession }) {
  const router = useRouter();
  const shift = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}°`;
  return (
    <View style={styles.sessionRow}>
      <View style={styles.sessionHead}>
        <Text style={styles.bold} numberOfLines={1}>
          {s.name}
        </Text>
        <Text style={styles.note}>
          {[s.date && day(s.date), s.track, s.ambient_c != null && `${s.ambient_c} °C`].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <Text style={styles.note}>
        {s.laps} laps, {s.samples.toLocaleString()} samples · slip shift front {shift(s.slip_shift_deg.front)}, rear{' '}
        {shift(s.slip_shift_deg.rear)}
      </Text>
      {s.event_id != null ? (
        <Pressable
          onPress={() => router.push({ pathname: '/event/[id]', params: { id: s.event_id! } })}
          accessibilityRole="link"
          accessibilityLabel={`Set the tyre of ${s.name} on its event`}>
          <Text style={styles.note}>
            Tyre: {s.tyre ?? '–'} <Text style={styles.link}>set on the event</Text>
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.note}>Tyre: {s.tyre ?? '–'}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 16 },
  section: { gap: 8 },
  advice: { gap: 6, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#8885' },
  adviceBlock: { gap: 4, marginTop: 4 },
  h2: { fontSize: 18, fontWeight: '700' },
  sub: { opacity: 0.7 },
  subhead: { fontWeight: '600' },
  said: { lineHeight: 20 },
  bold: { fontWeight: '600' },
  note: { fontSize: 12, opacity: 0.7 },
  link: { fontSize: 13, opacity: 0.75, textDecorationLine: 'underline' },
  error: { color: '#c8372d' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  filter: { gap: 4 },
  filterLabel: { fontSize: 12, opacity: 0.7 },
  input: {
    borderWidth: 1,
    borderColor: '#8884',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    width: 72,
    fontVariant: ['tabular-nums'],
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sessionRow: { gap: 2, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#8884' },
  sessionHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  prompt: { gap: 4 },
  linkText: { fontSize: 13, textDecorationLine: 'underline' },
  dimText: { opacity: 0.7 },
});
