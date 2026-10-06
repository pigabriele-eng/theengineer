import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  TextInputProps,
} from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
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
import { Radius, themed, useTheme } from '@/constants/Theme';

const AXLE_OF: Record<Corner, Axle> = { FL: 'front', FR: 'front', RL: 'rear', RR: 'rear' };

const empty = (): Record<Corner, string> => ({ FL: '', FR: '', RL: '', RR: '' });
const fmt = (x: number | null | undefined, digits = 2) => (x == null ? '–' : x.toFixed(digits));

// Four tyres laid out like the car seen from above, front at the top.
function CarGrid({ cell }: { cell: (c: Corner) => ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.car}>
      <Text style={styles.carLabel}>Front</Text>
      {[CORNERS.slice(0, 2), CORNERS.slice(2)].map((row) => (
        <View key={row[0]} style={styles.carRow}>
          {row.map((c) => (
            <View key={c} style={styles.carCell}>
              <Text style={styles.cornerName}>{c}</Text>
              {cell(c)}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

// A figure from an older public booklet, with a link to it.
function Ref({ r }: { r: Reference }) {
  const styles = useStyles();
  const tint = useThemeColor({}, 'tint');
  return (
    <Text style={styles.dim}>
      {r.text}{' '}
      <Text style={{ color: tint }} onPress={() => Linking.openURL(r.source)}>
        Source
      </Text>
    </Text>
  );
}

function Field(props: TextInputProps & { label?: string }) {
  const styles = useStyles();
  const theme = useTheme();
  const color = useThemeColor({}, 'text');
  const { label, style, ...rest } = props;
  return (
    <View style={styles.field}>
      {label && <Text style={styles.fieldLabel}>{label}</Text>}
      <TextInput
        placeholderTextColor={theme.textMuted}
        keyboardType="numbers-and-punctuation"
        {...rest}
        style={[styles.input, { color }, style]}
      />
    </View>
  );
}

export default function PressuresScreen() {
  const styles = useStyles();
  const theme = useTheme();
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
  const tint = useThemeColor({}, 'tint');
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

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Tyre pressures' }} />
      <Text style={styles.intro}>
        The cold pressures to set now so the tyres reach your target hot pressure: by the gas law, and by what your
        logged runs on this tyre show.
      </Text>

      <TyrePicker kinds={kinds} kindId={kindId} onPick={setKindId} notSet={notSet} />

      <Text style={styles.h2}>Conditions now</Text>
      <View style={styles.row}>
        <Field label="Ambient °C" value={ambient} onChangeText={setAmbient} placeholder="e.g. 18" />
        <Field label="Track °C" value={track} onChangeText={setTrack} placeholder="e.g. 30" />
      </View>
      <View style={styles.row}>
        <Field
          label="Tyre temp when setting °C"
          value={setTemp}
          onChangeText={setSetTemp}
          placeholder={ambient ? `${ambient} (ambient)` : 'e.g. 22 in the garage'}
        />
        <Field label="Air pressure bar" value={atmos} onChangeText={setAtmos} keyboardType="decimal-pad" />
      </View>

      <View style={styles.headRow}>
        <Text style={styles.h2}>Target hot pressure, bar</Text>
        <Pressable onPress={copyFirst}>
          <Text style={{ color: tint }}>Same for all</Text>
        </Pressable>
      </View>
      {kind && (hotTarget?.front != null || hotTarget?.rear != null) && (
        <Text style={styles.note}>Filled in from the P-Book hot target of {kind.label}; change it for today.</Text>
      )}
      <CarGrid
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

      <Text style={styles.h2}>Expected hot tyre temperature, °C</Text>
      <Text style={styles.note}>Optional. Empty uses what the TPMS read when hot in your logged runs.</Text>
      <CarGrid
        cell={(c) => (
          <Field
            value={hotTemps[c]}
            onChangeText={(v) => setHotTemps((cur) => ({ ...cur, [c]: v }))}
            placeholder={summary[c]?.median_hot_c != null ? `${Math.round(summary[c]!.median_hot_c!)} (runs)` : '°C'}
            accessibilityLabel={`${c} expected hot temperature`}
          />
        )}
      />

      <Pressable
        style={[styles.button, { backgroundColor: tint, opacity: kindId == null ? 0.5 : 1 }]}
        onPress={calculate}
        disabled={busy || kindId == null}>
        {busy ? <ActivityIndicator color={theme.onTint} /> : <Text style={styles.buttonText}>Calculate cold pressures</Text>}
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}

      {plan && <Results plan={plan} />}

      {kind && <PBookEditor key={kind.id} kind={kind} reference={reference} onSaved={loadKinds} />}

      {kind && <LoggedRuns tyre={kind.label} runs={runs} onChanged={loadRuns} />}
    </ScrollView>
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
  const tint = useThemeColor({}, 'tint');
  const router = useRouter();
  if (kinds == null) return <ActivityIndicator />;
  return (
    <View style={styles.section}>
      <View style={styles.headRow}>
        <Text style={styles.h2}>Tyre</Text>
        <Pressable onPress={() => router.push('/garage')} hitSlop={6}>
          <Text style={{ color: tint }}>Add a tyre in the garage</Text>
        </Pressable>
      </View>
      {kinds.length === 0 && (
        <Text style={styles.note}>
          No tyres in the garage yet. Add the tyre you run there (brand and compound): the calculator works per tyre,
          with that tyre's P-Book pressures and only the runs on it.
        </Text>
      )}
      <View style={styles.chips}>
        {kinds.map((k) => {
          const on = k.id === kindId;
          return (
            <Pressable
              key={k.id}
              onPress={() => onPick(k.id)}
              style={on ? StyleSheet.flatten([styles.chip, { borderColor: tint }]) : styles.chip}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}>
              <Text style={on ? { color: tint, fontWeight: '600' } : undefined}>{k.label}</Text>
              <Text style={styles.chipSub}>
                {k.sessions} session{k.sessions === 1 ? '' : 's'}
                {k.size ? ` · ${k.size}` : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {notSet && notSet.sessions > 0 && kinds.length > 0 && (
        <View style={styles.unset}>
          <Text style={styles.note}>
            {notSet.sessions} session{notSet.sessions === 1 ? ' has' : 's have'} no tyre set, so{' '}
            {notSet.sessions === 1 ? 'its runs are' : 'their runs are'} left out. Set the tyre on the event:
          </Text>
          {notSet.events.map((e) =>
            e.event_id != null ? (
              <Pressable
                key={e.event_id}
                onPress={() => router.push({ pathname: '/event/[id]', params: { id: e.event_id! } })}
                accessibilityRole="link">
                <Text style={{ color: tint }}>{eventLabel(e)}</Text>
              </Pressable>
            ) : (
              <Text key="none" style={styles.dim}>
                {e.sessions} session{e.sessions === 1 ? '' : 's'} in no event: put {e.sessions === 1 ? 'it' : 'them'}{' '}
                in an event first
              </Text>
            ),
          )}
        </View>
      )}
    </View>
  );
}

function Results({ plan }: { plan: PressurePlan }) {
  const theme = useTheme();
  const styles = useStyles();
  const by = Object.fromEntries(plan.corners.map((c) => [c.corner, c]));
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Set these cold</Text>
      <CarGrid
        cell={(c) => {
          const p = by[c];
          if (!p) return <Text style={styles.dim}>–</Text>;
          return (
            <View style={styles.result}>
              <Text style={StyleSheet.flatten([styles.big, { color: theme.tyre.cold }])}>
                {fmt(p.data.cold_bar ?? p.gas_law.cold_bar)}
              </Text>
              <Text style={styles.small}>Gas law {fmt(p.gas_law.cold_bar)}</Text>
              <Text style={styles.small}>
                Your data {fmt(p.data.cold_bar)}
                {p.data.runs ? ` · ${p.data.runs} runs` : ''}
              </Text>
              {p.flags.length > 0 && <Text style={styles.error}>Below a minimum</Text>}
            </View>
          );
        }}
      />
      <Text style={styles.note}>
        The big number is the data answer where there are logged runs, else the gas law.
        {plan.set_c_source && plan.set_c_source !== 'entered' ? ` Tyre temperature taken as ${plan.set_c_source}.` : ''}
      </Text>
      {plan.minimums.message && <Text style={styles.warn}>{plan.minimums.message}</Text>}
      <Ref r={plan.minimums.reference} />
      {plan.corners.map((p) => (
        <View key={p.corner} style={styles.card}>
          <Text style={styles.cardTitle}>
            {p.corner} · target <Text style={{ color: theme.tyre.hot }}>{p.target_hot_bar.toFixed(2)} bar hot</Text>
          </Text>
          {p.flags.map((f) => (
            <Text key={f} style={styles.error}>
              {f}
            </Text>
          ))}
          <Text style={styles.label}>Gas law</Text>
          <Text>{p.gas_law.text}</Text>
          {p.gas_law.hot_c_source && p.gas_law.hot_c_source !== 'entered' && (
            <Text style={styles.dim}>Hot temperature: {p.gas_law.hot_c_source}.</Text>
          )}
          {p.gas_law.runs_note && <Text style={styles.dim}>{p.gas_law.runs_note}</Text>}
          <Text style={styles.label}>Your logged runs</Text>
          <Text>{p.data.text}</Text>
        </View>
      ))}
    </View>
  );
}

const BOOK_FIELDS = [
  ['cold_min_bar', 'Cold min'],
  ['hot_min_bar', 'Hot min'],
  ['hot_target_bar', 'Hot target'],
] as const;

// The tyre's P-Book pressures, kept with the tyre: the minimums the answers are checked against and the hot targets
// the targets above start from.
function PBookEditor({ kind, reference, onSaved }: { kind: TyreKind; reference: Reference | null; onSaved: () => void }) {
  const styles = useStyles();
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
  const tint = useThemeColor({}, 'tint');

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
    <View style={styles.section}>
      <Text style={styles.h2}>P-Book pressures · {kind.label}</Text>
      {book.origin === null && (
        <Text style={styles.warn}>
          Not entered yet. The P-Book is issued to teams and is not public: enter the minimums and hot targets from
          your copy, and they stay with this tyre.
        </Text>
      )}
      {book.origin === 'series' && (
        <Text style={styles.note}>
          From the minimums entered for {(book.series ?? []).join(', ')} before tyres had their own. Save to keep them
          with this tyre.
        </Text>
      )}
      <Text style={styles.note}>In bar. The minimums are checked against every answer; the hot targets fill in the
        targets above.</Text>
      {(['front', 'rear'] as const).map((axle) => (
        <View key={axle} style={styles.row}>
          <Text style={styles.axle}>{axle === 'front' ? 'Front' : 'Rear'}</Text>
          {BOOK_FIELDS.map(([key, label]) => (
            <Field
              key={key}
              label={label}
              value={vals[`${axle}-${key}`] ?? ''}
              onChangeText={set(`${axle}-${key}`)}
              keyboardType="decimal-pad"
              accessibilityLabel={`${axle} ${label}`}
            />
          ))}
        </View>
      ))}
      <Field label="Source" value={vals.source ?? ''} onChangeText={set('source')} keyboardType="default"
        placeholder="P-Book edition and page" />
      <Pressable style={StyleSheet.flatten([styles.outline, { borderColor: tint }])} onPress={save} disabled={saving}>
        <Text style={{ color: tint }}>{saving ? 'Saving…' : `Save to ${kind.label}`}</Text>
      </Pressable>
      {msg && <Text style={styles.note}>{msg}</Text>}
      {reference && <Ref r={reference} />}
    </View>
  );
}

function LoggedRuns({ tyre, runs, onChanged }: { tyre: string; runs: LoggedRun[] | null; onChanged: () => void }) {
  const theme = useTheme();
  const styles = useStyles();
  const [tracks, setTracks] = useState<Record<number, string>>({});
  const saveTrack = async (sessionId: number) => {
    const v = tracks[sessionId];
    if (v === undefined) return;
    await tyres.setConditions(sessionId, { track_temp_c: num(v) ?? null }).catch(() => {});
    onChanged();
  };
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Your logged runs on {tyre}{runs ? ` (${runs.length})` : ''}</Text>
      <Text style={styles.note}>
        Only the sessions whose event ran this tyre. Cold is where each TPMS sensor first reported after the car
        rolled; hot is where the pressure settled after 12 minutes at speed. Enter a session's track temperature so
        the model can learn its effect.
      </Text>
      {runs == null && (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" />
          <Text style={styles.dim}>Reading the logs…</Text>
        </View>
      )}
      {runs?.length === 0 && (
        <Text style={styles.dim}>
          No logged run on this tyre yet: set the tyre on your events, and upload MoTeC logs with TPMS channels.
        </Text>
      )}
      {runs?.map((r) => (
        <View key={`${r.file_id}-${r.set}`} style={styles.card}>
          <Text style={styles.cardTitle}>
            {r.session}
            {r.set > 0 ? ` · tyre set ${r.set + 1} (fitted at ${Math.round(r.start_s / 60)} min)` : ''}
          </Text>
          <Text style={styles.dim}>{r.file}</Text>
          <View style={styles.row}>
            <Text style={styles.small}>
              Ambient {fmt(r.ambient_c, 1)} °C{r.ambient_source ? ` (${r.ambient_source})` : ''}
            </Text>
            <Field
              label="Track °C"
              value={tracks[r.session_id] ?? (r.track_c != null ? String(r.track_c) : '')}
              onChangeText={(v) => setTracks((cur) => ({ ...cur, [r.session_id]: v }))}
              onBlur={() => saveTrack(r.session_id)}
              style={styles.smallInput}
            />
          </View>
          {CORNERS.map((c) => {
            const x = r.corners[c];
            if (!x) return null;
            return (
              <Text key={c} style={[styles.small, !x.used && styles.dim]}>
                {c} <Text style={{ color: theme.tyre.cold }}>{fmt(x.cold_bar)}</Text> →{' '}
                <Text style={{ color: theme.tyre.hot }}>{fmt(x.hot_bar)}</Text> bar
                {x.rise_bar != null ? ` (+${fmt(x.rise_bar)})` : ''} · {fmt(x.cold_c, 0)} → {fmt(x.hot_c, 0)} °C
                {x.note ? ` · ${x.note}` : ''}
              </Text>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const useStyles = themed((c) => ({
  container: { padding: 16, gap: 12, maxWidth: 720, width: '100%', alignSelf: 'center' },
  intro: { opacity: 0.8 },
  h2: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-end' },
  field: { flex: 1, gap: 4 },
  fieldLabel: { fontSize: 12, opacity: 0.6 },
  input: {
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: Radius.control,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    fontVariant: ['tabular-nums'], backgroundColor: c.surface,
  },
  smallInput: { paddingVertical: 4, fontSize: 14 },
  car: { gap: 8, padding: 8, borderRadius: Radius.card, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  carLabel: { textAlign: 'center', fontSize: 12, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 1 },
  carRow: { flexDirection: 'row', gap: 12 },
  carCell: { flex: 1, gap: 4 },
  cornerName: { fontWeight: '700' },
  result: { gap: 2 },
  big: { fontSize: 26, fontWeight: '600', fontVariant: ['tabular-nums'] },
  small: { fontSize: 13, fontVariant: ['tabular-nums'] },
  button: { borderRadius: Radius.control, padding: 14, alignItems: 'center' },
  buttonText: { color: c.onTint, fontWeight: '600', fontSize: 16 },
  outline: { borderRadius: Radius.control, padding: 12, alignItems: 'center', borderWidth: 1 },
  error: { color: c.error },
  warn: { color: c.warning },
  note: { opacity: 0.7, fontSize: 13 },
  dim: { opacity: 0.55, fontSize: 13 },
  section: { gap: 10 },
  card: { paddingVertical: 10, borderBottomWidth: 1, borderColor: c.separator, gap: 4 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  label: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  axle: { width: 40, fontWeight: '600', paddingBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.chip, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.surface },
  chipSub: { fontSize: 12, opacity: 0.6 },
  unset: { gap: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
}));
