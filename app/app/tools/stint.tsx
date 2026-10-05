import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { api, formatLap, Session } from '@/lib/api';
import {
  average,
  fadeWords,
  fetchStint,
  fixed,
  KIND_LABEL,
  signed,
  Stint,
  StintAnalysis,
  StintLap,
} from '@/lib/stint';

// Stint analysis: pick a session, then each stint lap by lap and how the car faded through it.
// Open with ?session=<id> to start on one session.
export default function StintScreen() {
  const params = useLocalSearchParams<{ session?: string }>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [picked, setPicked] = useState<number | null>(params.session ? Number(params.session) : null);
  const [result, setResult] = useState<StintAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');

  useEffect(() => {
    api.sessions().then(setSessions, (e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (picked == null) return;
    let live = true;
    setBusy(true);
    setError(null);
    setResult(null);
    fetchStint(picked)
      .then((r) => live && setResult(r))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [picked]);

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Stint analysis' }} />
      <Text style={styles.intro}>
        Lap by lap through each stint: grip in use, cornering g, balance and tyres, and how much the car fades.
      </Text>

      <Text style={styles.h2}>Session</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {sessions.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => setPicked(s.id)}
            style={[styles.chip, s.id === picked && { borderColor: tint }]}>
            <Text style={s.id === picked ? { color: tint } : undefined}>{s.name ?? `Session ${s.id}`}</Text>
            <Text style={styles.chipSub}>{formatLap(s.best_lap_s)}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {sessions.length === 0 && !error && (
        <Text style={styles.dim}>No sessions yet. Upload a logger file (.ld or a CSV export) to a session first.</Text>
      )}

      {busy && <ActivityIndicator />}
      {error && <Text style={styles.error}>{error}</Text>}

      {result && (
        <>
          {result.notes.map((n) => (
            <Text key={n} style={styles.note}>
              {n}
            </Text>
          ))}
          {result.stints.map((s) => (
            <StintView key={s.number} stint={s} unit={result.steer_unit ?? ''} />
          ))}
        </>
      )}
    </ScrollView>
  );
}

function StintView({ stint, unit }: { stint: Stint; unit: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>
        Stint {stint.number} · laps {stint.first_lap}–{stint.last_lap}
      </Text>
      <View style={styles.facts}>
        {fadeWords(stint).map((f) => (
          <View key={f.label} style={styles.fact}>
            <Text style={styles.factLabel}>{f.label}</Text>
            <Text style={styles.factValue}>{f.value}</Text>
          </View>
        ))}
      </View>
      {stint.notes.map((n) => (
        <Text key={n} style={styles.note}>
          {n}
        </Text>
      ))}
      <LapTable laps={stint.laps} unit={unit} />
    </View>
  );
}

const COLUMNS: { title: string; width: number; value: (l: StintLap) => string }[] = [
  { title: 'Lap', width: 56, value: (l) => `${l.lap}${KIND_LABEL[l.kind] ? ` ${KIND_LABEL[l.kind]}` : ''}` },
  { title: 'Time', width: 72, value: (l) => formatLap(l.time) },
  { title: 'Grip %', width: 56, value: (l) => fixed(l.grip_use) },
  { title: 'Peak g', width: 56, value: (l) => fixed(l.peak_lat_g, 2) },
  { title: '1 s g', width: 52, value: (l) => fixed(l.sustained_lat_g, 2) },
  { title: 'Entry', width: 52, value: (l) => signed(l.balance?.entry) },
  { title: 'Mid', width: 52, value: (l) => signed(l.balance?.mid) },
  { title: 'Exit', width: 52, value: (l) => signed(l.balance?.exit) },
  { title: 'TC s', width: 44, value: (l) => fixed(l.tc_s) },
  { title: 'ABS s', width: 48, value: (l) => fixed(l.abs_s) },
  { title: 'Tyre bar', width: 64, value: (l) => fixed(average(l.tyres?.pressure_bar), 2) },
  { title: 'Tyre °C', width: 60, value: (l) => fixed(average(l.tyres?.temperature_c), 0) },
];

function LapTable({ laps, unit }: { laps: StintLap[]; unit: string }) {
  const tint = useThemeColor({}, 'tint');
  return (
    <>
      <ScrollView horizontal>
        <View>
          <View style={styles.row}>
            {COLUMNS.map((c) => (
              <Text key={c.title} style={[styles.cell, styles.head, { width: c.width }]}>
                {c.title}
              </Text>
            ))}
          </View>
          {laps.map((l) => (
            <View key={l.lap} style={styles.row}>
              {COLUMNS.map((c) => (
                <Text
                  key={c.title}
                  style={[
                    styles.cell,
                    { width: c.width },
                    !l.in_fit && styles.dim,
                    l.outlier && c.title === 'Time' && { color: tint },
                  ]}>
                  {c.value(l)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      <Text style={styles.legend}>
        Grey laps are left out of the trend (out, in, pit and slow laps; coloured times are outliers). Grip % is the
        share of the grip the car showed on its best laps. Entry, mid and exit balance: {unit} of steering against the
        car's own average at the same cornering g, + more understeer, − more oversteer.
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12 },
  intro: { opacity: 0.7 },
  h2: { fontSize: 18, fontWeight: '700' },
  chips: { gap: 8 },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  chipSub: { fontSize: 12, opacity: 0.6, fontVariant: ['tabular-nums'] },
  error: { color: '#c8372d' },
  note: { lineHeight: 20 },
  section: { gap: 8, marginTop: 8 },
  facts: { flexDirection: 'row', gap: 24, flexWrap: 'wrap' },
  fact: { gap: 2 },
  factLabel: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  factValue: { fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#8882', paddingVertical: 4 },
  cell: { fontVariant: ['tabular-nums'], fontSize: 13, paddingRight: 6, textAlign: 'right' },
  head: { fontWeight: '600', opacity: 0.7 },
  dim: { opacity: 0.4 },
  legend: { fontSize: 12, opacity: 0.6, lineHeight: 17 },
});
