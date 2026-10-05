import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { TraceChart, useSeriesColors } from '@/components/TraceChart';
import { Analysis, api, DETECTED_CORNERS_NOTE, formatLap, Lap, LapCompare as Compare } from '@/lib/api';

type Props = { sessionId: number; analysis: Analysis; laps: Lap[] };

/** A lap against the reference lap: time delta, speed, throttle and brake on one distance axis. */
export function LapCompare({ sessionId, analysis, laps: allLaps }: Props) {
  const ref = analysis.reference_lap;
  const laps = allLaps.filter((l) => l.file_id === analysis.file_id);
  const clean = laps.filter((l) => l.clean && l.number !== ref);
  const nextBest = [...clean].sort((a, b) => a.time_s - b.time_s)[0];
  const [lap, setLap] = useState<number | null>(nextBest?.number ?? null);
  const [data, setData] = useState<Compare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const colors = useSeriesColors();
  const tint = useThemeColor({}, 'tint');

  useEffect(() => {
    if (lap == null) return;
    setError(null);
    api.compare(sessionId, lap, ref).then(setData, (e) => setError(e.message));
  }, [sessionId, lap, ref]);

  if (lap == null) return null;
  const markers = (data?.corners ?? analysis.corners).map((c) => ({ at: c.apex_m, label: c.code }));
  const detected = (data?.numbering ?? analysis.numbering) === 'detected';
  const time = (n: number) => formatLap(laps.find((l) => l.number === n)?.time_s);
  const shared = { distance: data?.distance ?? [], cursor, onCursor: setCursor, markers };
  const pair = (role: 'speed' | 'throttle' | 'brake') =>
    data?.reference[role] && data.compare[role]
      ? [
          { values: data.reference[role]!, color: colors.reference },
          { values: data.compare[role]!, color: colors.compare },
        ]
      : null;

  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Compare laps</Text>
      <View style={styles.chips}>
        {clean.map((l) => (
          <Pressable key={l.number} onPress={() => setLap(l.number)}
            style={[styles.chip, l.number === lap && { borderColor: tint }]}>
            <Text style={l.number === lap ? { color: tint } : undefined}>
              L{l.number} {formatLap(l.time_s)}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.legend}>
        <Text>
          <Text style={{ color: colors.reference }}>●</Text> L{ref} {time(ref)} (reference)
        </Text>
        <Text>
          <Text style={{ color: colors.compare }}>●</Text> L{lap} {time(lap)}
        </Text>
        {cursor != null && data && (
          <Text style={styles.at}>at {Math.round(data.distance[cursor])} m</Text>
        )}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      {!data && !error && <ActivityIndicator />}
      {data && (
        <>
          <TraceChart {...shared} title="Time vs reference" unit="s" zeroLine height={110}
            series={[{ values: data.delta, color: colors.compare }]} />
          {pair('speed') && <TraceChart {...shared} title="Speed" unit="km/h" series={pair('speed')!} />}
          {pair('throttle') && (
            <TraceChart {...shared} title="Throttle" unit="%" domain={[0, 100]} height={100} series={pair('throttle')!} />
          )}
          {pair('brake') && <TraceChart {...shared} title="Brake" unit="" height={100} series={pair('brake')!} />}
          <Text style={styles.hint}>
            Above zero, L{lap} is behind the reference at that point. Drag across a chart to read values.
            {detected && markers.length > 0 ? ` ${DETECTED_CORNERS_NOTE}` : ''}
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  h2: { fontSize: 18, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 4 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  at: { opacity: 0.7, fontVariant: ['tabular-nums'] },
  error: { color: '#c8372d' },
  hint: { fontSize: 12, opacity: 0.6 },
});
