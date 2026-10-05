// For the vehicle model: pick a run with a setup sheet and load its setup (bars, spring rates, fuel and ballast,
// ride heights) on top of the car's preset.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { SetupListItem, setupApi, SetupVehicle } from '@/lib/setup';
import { Vehicle } from '@/lib/vehicle';

export function SetupLoader({
  initial,
  ready,
  onLoad,
}: {
  initial?: number; // a session to load straight away (from ?session=)
  ready: boolean; // the preset is in the form, so a loaded setup isn't overwritten by it
  onLoad: (v: Vehicle) => void;
}) {
  const [runs, setRuns] = useState<SetupListItem[]>([]);
  const [loaded, setLoaded] = useState<SetupVehicle | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');

  useEffect(() => {
    setupApi.withSheets().then(setRuns, () => {});
  }, []);

  const load = async (id: number) => {
    setBusy(id);
    setError(null);
    try {
      const v = await setupApi.vehicle(id);
      setLoaded(v);
      onLoad(v.vehicle);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (ready && initial != null) load(initial);
    // only once the preset is in, and only for the session the screen was opened with
  }, [ready, initial]);

  if (!runs.length && initial == null) return null;
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Load a run's setup</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {runs.map((r) => {
          const on = loaded?.session_id === r.session_id;
          return (
            <Pressable
              key={r.session_id}
              onPress={() => load(r.session_id)}
              disabled={!ready || busy != null}
              style={[styles.chip, on && { borderColor: tint }]}>
              {busy === r.session_id ? (
                <ActivityIndicator />
              ) : (
                <Text style={on ? { color: tint } : undefined}>{r.name ?? `Session ${r.session_id}`}</Text>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
      {error && <Text style={styles.error}>{error}</Text>}
      {loaded && (
        <View style={styles.box}>
          <Text style={styles.sub}>
            {loaded.name ?? 'This run'}: {loaded.applied.map((a) => a.from).join(' · ') || 'nothing the model uses'}
          </Text>
          {loaded.notes.map((n) => (
            <Text key={n} style={styles.note}>
              {n}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6 },
  title: { fontWeight: '600' },
  chips: { gap: 8 },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  sub: { opacity: 0.8 },
  note: { fontSize: 12, opacity: 0.7 },
  error: { color: '#c8372d' },
});
