import { useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { Cells, Field, SubHead, usePrepType } from '@/components/PrepParts';
import { Fig, Label, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { OfficialSessionRow, PredictedQuali, PredictedRace, PrepOfficial } from '@/lib/prep';
import { resultsApi } from '@/lib/results';
import { face, themed, Type, useTheme } from '@/constants/Theme';

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
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(data.car_number ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        <Label>
          Car #{data.car_number}{data.team ? ` · ${data.team}` : ''}{data.brand ? ` · ${data.brand}` : ''}
          {data.car_number_from ? <Text style={styles.from}>{`  (${data.car_number_from})`}</Text> : null}
        </Label>
        <TextLink label="Change" small onPress={() => setEditing(true)} />
      </View>
    );
  }
  return (
    <View style={styles.ask}>
      <Label>Which car number is ours?</Label>
      <View style={styles.fieldRow}>
        <Field value={value} onChangeText={setValue} placeholder="e.g. 12" width={120}
          inputMode="numeric" maxLength={6} accessibilityLabel="Our car number" onSubmitEditing={save} />
        {/* each link in a view of its own: it lines its underline up with the field's rule */}
        <View>{saving ? <ActivityIndicator color={theme.text} />
          : <TextLink label="Save" red onPress={save} disabled={!value.trim()} />}</View>
        {editing && <View><TextLink label="Cancel" small onPress={() => setEditing(false)} /></View>}
      </View>
      {error && <Text style={type.error}>{error}</Text>}
    </View>
  );
}

/** Where we finished here each year, in what weather; whether it's a strong or a weak track for us; the makes. */
export function OfficialResults({ eventId, data, onChanged }: {
  eventId: number;
  data: PrepOfficial | null;
  onChanged: () => void;
}) {
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
  const wide = useWide();
  if (!data) return <ActivityIndicator color={theme.text} style={styles.loading} />;
  if (!data.loaded) return <Text style={type.note}>{data.note}</Text>;
  const ours = !!data.car_number;
  return (
    <View style={styles.block}>
      <CarNumber key={data.car_number ?? ''} eventId={eventId} data={data} onSaved={onChanged} />
      {data.note && ours && <Text style={type.note}>{data.note}</Text>}
      {data.years.map((y) => (
        <View key={y.year} style={styles.year}>
          <SubHead kicker={y.name} title={String(y.year)} />
          <Cells cols={Math.max(4, y.sessions.length)} phoneCols={2}>
            {y.sessions.map((s) => <SessionCell key={s.code} s={s} ours={ours} />)}
          </Cells>
        </View>
      ))}
      {data.track_verdict?.text && <Text style={wide ? type.read : type.readPhone}>{data.track_verdict.text}</Text>}
      {data.track_verdict && (data.track_verdict.strongest.length > 0 || data.track_verdict.weakest.length > 0) && (
        <Text style={type.small}>
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
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  const quali = s.code.startsWith('Q');
  const sub = !s.dry ? 'wet' : quali && s.to_fastest_pct != null ? `${pct(s.to_fastest_pct)} to the fastest` : null;
  return (
    <View>
      <Fig label={ours ? s.code : `${s.code} · fastest lap`} value={ours ? s.place : formatLap(s.fastest_s)}
        size={wide ? 48 : 34} />
      <View style={styles.under}>
        {ours && s.class_position != null && s.car_class && (
          <Text style={type.small}>P{s.class_position} of {s.class_cars} {s.car_class}</Text>
        )}
        {sub && <Text style={type.small}>{sub}</Text>}
        {temps(s.weather) ? <Text style={type.small}>{temps(s.weather)}</Text> : null}
      </View>
    </View>
  );
}

function Makes({ makes }: { makes: NonNullable<PrepOfficial['makes']> }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  return (
    <View style={styles.makes}>
      <SubHead kicker="The makes" title={`${makes.year} ${makes.code}`} />
      {makes.text && <Text style={StyleSheet.flatten([wide ? type.read : type.readPhone, styles.makesText])}>{makes.text}</Text>}
      <View style={styles.thRow}>
        <Text style={StyleSheet.flatten([styles.th, styles.makeName])}>Make</Text>
        <Text style={StyleSheet.flatten([styles.th, styles.makeNum])}>Best lap</Text>
        <Text style={StyleSheet.flatten([styles.th, styles.makeNum])}>To fastest</Text>
        <Text style={StyleSheet.flatten([styles.th, styles.makeNum])}>Best place</Text>
      </View>
      {makes.rows.map((m) => (
        // our make: a band of the darker paper across the row, in bold
        <View key={m.brand} style={StyleSheet.flatten([styles.make, m.ours && styles.makeOurs])}>
          <Text style={StyleSheet.flatten([styles.td, styles.makeName, m.ours && styles.bold])} numberOfLines={1}>
            {m.brand}{m.cars > 1 ? ` ×${m.cars}` : ''}{m.ours ? '  · ours' : ''}
          </Text>
          <Text style={StyleSheet.flatten([styles.td, styles.makeNum, m.ours && styles.bold])}>{formatLap(m.best_s)}</Text>
          <Text style={StyleSheet.flatten([styles.td, styles.makeNum, m.ours && styles.bold])}>{pct(m.to_fastest_pct) ?? ''}</Text>
          <Text style={StyleSheet.flatten([styles.td, styles.makeNum, m.ours && styles.bold])}>
            {m.best_position != null ? `P${m.best_position}` : ''}
          </Text>
        </View>
      ))}
      {makes.makes > makes.rows.length && (
        <Text style={StyleSheet.flatten([type.note, styles.after])}>
          The quickest {makes.rows.length} of {makes.makes} makes{'; ours always shown'}.
        </Text>
      )}
    </View>
  );
}

/** The prediction for this round: places as likely ranges, our lap and pole, why, and how far to trust it. */
export function Prediction({ data }: { data: PrepOfficial | null }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  const [more, setMore] = useState(false);
  const p = data?.prediction;
  if (!data || !p) return null;
  const s = p.sessions;
  return (
    <View style={styles.block}>
      <Cells cols={4} phoneCols={2}>
        {[
          ...(['Q1', 'Q2'] as const).map((c) => s[c] && <QualiCell key={c} code={c} q={s[c]!} />),
          ...(['R1', 'R2'] as const).map((c) => s[c] && <RaceCell key={c} code={c} r={s[c]!} />),
        ]}
      </Cells>
      {data.trust?.text && <Text style={wide ? type.read : type.readPhone}>{data.trust.text}</Text>}
      {p.explain.map((l) => <Text key={l} style={type.note}>{l}</Text>)}
      <View style={styles.after}>
        <TextLink label={more ? 'Hide the small print' : 'Small print'} small onPress={() => setMore(!more)} />
      </View>
      {more && [...p.notes, ...(data.trust?.summary ?? [])].map((l) => <Text key={l} style={type.note}>{l}</Text>)}
    </View>
  );
}

function QualiCell({ code, q }: { code: string; q: PredictedQuali }) {
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
  const wide = useWide();
  return (
    <View>
      <Fig label={code} value={q.position != null ? `P${q.position}` : '–'} size={wide ? 64 : 44} bar={theme.rule}
        barHeight={4} />
      <View style={styles.under}>
        {q.position_range && <Text style={type.small}>likely {range(q.position_range, place)}</Text>}
        {q.our_time_s != null && (
          <Text style={type.small}>{formatLap(q.our_time_s)}{q.our_time_range_s
            ? ` (${range(q.our_time_range_s, (v) => formatLap(v))})` : ''}</Text>
        )}
        {q.pole_s != null && <Text style={type.small}>pole {formatLap(q.pole_s)}</Text>}
      </View>
    </View>
  );
}

function RaceCell({ code, r }: { code: string; r: PredictedRace }) {
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
  const wide = useWide();
  return (
    <View>
      <Fig label={code} value={r.position != null ? `P${r.position}` : '–'} size={wide ? 64 : 44} bar={theme.rule}
        barHeight={4} />
      <View style={styles.under}>
        {r.position_range && <Text style={type.small}>likely {range(r.position_range, place)}</Text>}
        <Text style={type.small}>from the {r.grid_from} grid, if we finish</Text>
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  loading: { alignSelf: 'flex-start' },
  block: { gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', columnGap: 16, rowGap: 8, flexWrap: 'wrap' },
  from: { fontFamily: face('label', 500), letterSpacing: 0.4, textTransform: 'none', color: c.textSecondary },
  ask: { gap: 8, borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.rule, paddingTop: 10, paddingBottom: 12 },
  fieldRow: { flexDirection: 'row', alignItems: 'flex-end', columnGap: 18, rowGap: 8, flexWrap: 'wrap' },
  year: { marginTop: 10 },
  under: { marginTop: 8, gap: 2 },
  after: { marginTop: 4 },
  makes: { marginTop: 14 },
  makesText: { marginBottom: 10 },
  thRow: { flexDirection: 'row', gap: 8, borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 5 },
  th: { ...Type.label, fontFamily: face('label', 700), fontSize: 12, letterSpacing: 1.2, color: c.text },
  make: { flexDirection: 'row', gap: 8, alignItems: 'baseline', borderBottomWidth: 1, borderColor: c.separator,
    paddingTop: 6, paddingBottom: 6, paddingHorizontal: 4 },
  makeOurs: { backgroundColor: c.band },
  makeName: { flex: 1.4, minWidth: 0 },
  makeNum: { flex: 1, textAlign: 'right' },
  td: { fontFamily: face('label', 500), fontSize: 15, fontVariant: ['tabular-nums'], color: c.text },
  bold: { fontFamily: face('label', 700) },
}));
