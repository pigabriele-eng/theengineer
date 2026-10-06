import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { OfficialSessionRow, PredictedQuali, PredictedRace, PrepOfficial } from '@/lib/prep';
import { resultsApi } from '@/lib/results';

const pct = (v: number | null | undefined) => (v == null ? null : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} %`);
const range = (r: [number, number] | null | undefined, f: (v: number) => string) =>
  !r ? null : r[0] === r[1] ? f(r[0]) : `${f(r[0])}–${f(r[1])}`;
const place = (v: number) => `P${v}`;
const temps = (w: { air_c: number | null; track_c: number | null }) =>
  [w.air_c != null ? `air ${w.air_c.toFixed(0)} °C` : null, w.track_c != null ? `track ${w.track_c.toFixed(0)} °C` : null]
    .filter(Boolean).join(', ');

/** Our car number for the official results: shown with where it came from, and asked for when it isn't known. Saved
 * on this event (the results' own link), so every screen that shows results uses it. */
export function CarNumber({ eventId, data, onSaved }: { eventId: number; data: PrepOfficial; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(data.car_number ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = useThemeColor({}, 'text');
  const tint = useThemeColor({}, 'tint');
  const asking = !data.car_number || editing;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await resultsApi.link(eventId, { car_number: value.trim() });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  if (!asking) {
    return (
      <View style={styles.row}>
        <Text style={styles.note}>
          Car #{data.car_number}{data.team ? ` · ${data.team}` : ''}{data.brand ? ` · ${data.brand}` : ''}
          {data.car_number_from ? ` (${data.car_number_from})` : ''}
        </Text>
        <Pressable accessibilityRole="button" onPress={() => setEditing(true)} hitSlop={8}>
          <Text style={StyleSheet.flatten([styles.linkText, { color: tint }])}>Change</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.ask}>
      <Text style={styles.label}>Which car number is ours?</Text>
      <View style={styles.row}>
        <TextInput value={value} onChangeText={setValue} placeholder="e.g. 12" placeholderTextColor="#888"
          inputMode="numeric" maxLength={6} accessibilityLabel="Our car number" onSubmitEditing={save}
          style={StyleSheet.flatten([styles.input, { color: text }])} />
        <Pressable accessibilityRole="button" onPress={save} disabled={saving || !value.trim()}
          style={StyleSheet.flatten([styles.button, { borderColor: tint }, (saving || !value.trim()) && styles.off])}>
          {saving ? <ActivityIndicator /> : (
            <Text style={StyleSheet.flatten([styles.buttonText, { color: tint }])}>Save</Text>)}
        </Pressable>
        {editing && (
          <Pressable accessibilityRole="button" onPress={() => setEditing(false)} hitSlop={8}>
            <Text style={styles.note}>Cancel</Text>
          </Pressable>
        )}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

/** Where we finished here each year, in what weather; whether it's a strong or a weak track for us; the makes. */
export function OfficialResults({ eventId, data, onChanged }: {
  eventId: number;
  data: PrepOfficial | null;
  onChanged: () => void;
}) {
  if (!data) return <ActivityIndicator />;
  if (!data.loaded) return <Text style={styles.note}>{data.note}</Text>;
  const ours = !!data.car_number;
  return (
    <View style={styles.block}>
      <CarNumber key={data.car_number ?? ''} eventId={eventId} data={data} onSaved={onChanged} />
      {data.note && ours && <Text style={styles.note}>{data.note}</Text>}
      {data.years.map((y) => (
        <View key={y.year} style={styles.year}>
          <Text style={styles.yearHead}>{y.year} · {y.name}</Text>
          <View style={styles.grid}>
            {y.sessions.map((s) => <SessionCell key={s.code} s={s} ours={ours} />)}
          </View>
        </View>
      ))}
      {data.track_verdict?.text && <Text style={styles.para}>{data.track_verdict.text}</Text>}
      {data.track_verdict && (data.track_verdict.strongest.length > 0 || data.track_verdict.weakest.length > 0) && (
        <Text style={styles.note}>
          {[data.track_verdict.strongest.length ? `Strongest tracks: ${data.track_verdict.strongest.join(', ')}` : null,
            data.track_verdict.weakest.length ? `weakest: ${data.track_verdict.weakest.join(', ')}` : null]
            .filter(Boolean).join(' · ')}.
        </Text>
      )}
      {data.makes && <Makes makes={data.makes} />}
    </View>
  );
}

function SessionCell({ s, ours }: { s: OfficialSessionRow; ours: boolean }) {
  const quali = s.code.startsWith('Q');
  const sub = !s.dry ? 'wet' : quali && s.to_fastest_pct != null ? `${pct(s.to_fastest_pct)} to the fastest` : null;
  return (
    <View style={styles.cell}>
      <Text style={styles.cellLabel}>{s.code}</Text>
      <Text style={styles.cellValue}>{ours ? s.place : formatLap(s.fastest_s)}</Text>
      {!ours && <Text style={styles.note}>fastest lap</Text>}
      {ours && s.class_position != null && s.car_class && (
        <Text style={styles.note}>P{s.class_position} of {s.class_cars} {s.car_class}</Text>
      )}
      {sub && <Text style={styles.note}>{sub}</Text>}
      {temps(s.weather) ? <Text style={styles.note}>{temps(s.weather)}</Text> : null}
    </View>
  );
}

function Makes({ makes }: { makes: NonNullable<PrepOfficial['makes']> }) {
  const tint = useThemeColor({}, 'tint');
  return (
    <View style={styles.block}>
      <Text style={styles.label}>Makes in {makes.year} {makes.code}</Text>
      {makes.text && <Text style={styles.para}>{makes.text}</Text>}
      {makes.rows.map((m) => {
        const mark = m.ours ? { color: tint, fontWeight: '700' as const } : null;
        return (
          <View key={m.brand} style={styles.make}>
            <Text style={StyleSheet.flatten([styles.makeName, mark])} numberOfLines={1}>
              {m.brand}{m.cars > 1 ? ` ×${m.cars}` : ''}
            </Text>
            <Text style={StyleSheet.flatten([styles.makeNum, mark])}>{formatLap(m.best_s)}</Text>
            <Text style={StyleSheet.flatten([styles.makeNum, mark])}>{pct(m.to_fastest_pct) ?? ''}</Text>
            <Text style={StyleSheet.flatten([styles.makeNum, mark])}>
              {m.best_position != null ? `best P${m.best_position}` : ''}
            </Text>
          </View>
        );
      })}
      {makes.makes > makes.rows.length && (
        <Text style={styles.note}>The quickest {makes.rows.length} of {makes.makes} makes{'; ours always shown'}.</Text>
      )}
    </View>
  );
}

/** The prediction for this round: places as likely ranges, our lap and pole, why, and how far to trust it. */
export function Prediction({ data }: { data: PrepOfficial | null }) {
  const [more, setMore] = useState(false);
  const p = data?.prediction;
  if (!data || !p) return null;
  const s = p.sessions;
  return (
    <View style={styles.block}>
      <View style={styles.grid}>
        {(['Q1', 'Q2'] as const).map((c) => s[c] && <QualiCell key={c} code={c} q={s[c]!} />)}
        {(['R1', 'R2'] as const).map((c) => s[c] && <RaceCell key={c} code={c} r={s[c]!} />)}
      </View>
      {data.trust?.text && <Text style={styles.para}>{data.trust.text}</Text>}
      {p.explain.map((l) => <Text key={l} style={styles.note}>{l}</Text>)}
      <Pressable accessibilityRole="button" onPress={() => setMore(!more)}>
        <Text style={styles.link}>{more ? 'Hide the small print' : 'Small print'}</Text>
      </Pressable>
      {more && [...p.notes, ...(data.trust?.summary ?? [])].map((l) => <Text key={l} style={styles.note}>{l}</Text>)}
    </View>
  );
}

function QualiCell({ code, q }: { code: string; q: PredictedQuali }) {
  return (
    <View style={styles.cell}>
      <Text style={styles.cellLabel}>{code}</Text>
      <Text style={styles.cellValue}>{q.position != null ? `P${q.position}` : '–'}</Text>
      {q.position_range && <Text style={styles.note}>likely {range(q.position_range, place)}</Text>}
      {q.our_time_s != null && (
        <Text style={styles.note}>{formatLap(q.our_time_s)}{q.our_time_range_s
          ? ` (${range(q.our_time_range_s, (v) => formatLap(v))})` : ''}</Text>
      )}
      {q.pole_s != null && <Text style={styles.note}>pole {formatLap(q.pole_s)}</Text>}
    </View>
  );
}

function RaceCell({ code, r }: { code: string; r: PredictedRace }) {
  return (
    <View style={styles.cell}>
      <Text style={styles.cellLabel}>{code}</Text>
      <Text style={styles.cellValue}>{r.position != null ? `P${r.position}` : '–'}</Text>
      {r.position_range && <Text style={styles.note}>likely {range(r.position_range, place)}</Text>}
      <Text style={styles.note}>from the {r.grid_from} grid, if we finish</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  ask: { gap: 6, borderWidth: 1, borderStyle: 'dashed', borderColor: '#8886', borderRadius: 10, padding: 10 },
  label: { fontSize: 14, fontWeight: '700' },
  note: { fontSize: 12.5, opacity: 0.65, lineHeight: 18 },
  para: { fontSize: 14.5, lineHeight: 21 },
  link: { fontSize: 13.5, opacity: 0.7, textDecorationLine: 'underline' },
  linkText: { fontSize: 13.5, fontWeight: '600' },
  error: { color: '#c8372d' },
  input: { borderWidth: 1, borderColor: '#8884', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
    fontSize: 16, width: 110 },
  button: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  buttonText: { fontWeight: '700', fontSize: 14 },
  off: { opacity: 0.5 },
  year: { borderTopWidth: 1, borderColor: '#8883', paddingTop: 8, gap: 6 },
  yearHead: { fontSize: 15, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  cell: { minWidth: 150, flexGrow: 1, flexBasis: 150, gap: 1, borderWidth: 1, borderColor: '#8883', borderRadius: 8,
    padding: 8 },
  cellLabel: { fontSize: 11.5, opacity: 0.6, fontWeight: '700' },
  cellValue: { fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  make: { flexDirection: 'row', gap: 8, alignItems: 'baseline', borderTopWidth: 1, borderColor: '#8882', paddingTop: 4 },
  makeName: { flex: 1.4, fontSize: 14 },
  makeNum: { flex: 1, fontSize: 14, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
