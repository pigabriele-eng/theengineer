import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { Choice, useText } from '@/components/Picks';
import { Swatch } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { TraceChart, useSeriesColors } from '@/components/TraceChart';
import { Analysis, api, DETECTED_CORNERS_NOTE, formatLap, Lap, LapCompare as Compare } from '@/lib/api';
import { themed, Type, useTheme } from '@/constants/Theme';

type Props = {
  sessionId: number;
  analysis: Analysis;
  laps: Lap[];
  // inside a page's own numbered section: no "Compare laps" heading of its own and no frame, the lap picks and the
  // charts only
  bare?: boolean;
};

/** A lap against the reference lap: time delta, speed, throttle and brake on one distance axis. The laps to pick as
 * the programme's figures (the picked one underlined in red), the charts in the programme's chrome. */
export function LapCompare({ sessionId, analysis, laps: allLaps, bare = false }: Props) {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const ref = analysis.reference_lap;
  const laps = allLaps.filter((l) => l.file_id === analysis.file_id);
  const clean = laps.filter((l) => l.clean && l.number !== ref);
  const nextBest = [...clean].sort((a, b) => a.time_s - b.time_s)[0];
  const [lap, setLap] = useState<number | null>(nextBest?.number ?? null);
  const [data, setData] = useState<Compare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const colors = useSeriesColors();

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
      {!bare && <Text style={t.sub}>Compare laps</Text>}
      <View style={styles.picks}>
        {clean.map((l) => (
          <Choice key={l.number} label={`${l.number}`} detail={formatLap(l.time_s)} on={l.number === lap}
            onPress={() => setLap(l.number)} accessibilityLabel={`Lap ${l.number}, ${formatLap(l.time_s)}`} />
        ))}
      </View>

      <View style={styles.legend}>
        <Swatch color={colors.reference} label={`L${ref} ${time(ref)} (reference)`} width={14} height={4} />
        <Swatch color={colors.compare} label={`L${lap} ${time(lap)}`} width={14} height={4} />
        {cursor != null && data && <Text style={styles.at}>at {Math.round(data.distance[cursor])} m</Text>}
      </View>

      {error && <Text style={t.error}>{error}</Text>}
      {!data && !error && <ActivityIndicator color={theme.text} style={styles.left} />}
      {data && (
        <View style={styles.charts}>
          <TraceChart {...shared} title="Time vs reference" unit="s" zeroLine height={110}
            series={[{ values: data.delta, color: colors.compare }]} />
          {pair('speed') && <TraceChart {...shared} title="Speed" unit="km/h" series={pair('speed')!} />}
          {pair('throttle') && (
            <TraceChart {...shared} title="Throttle" unit="%" domain={[0, 100]} height={100} series={pair('throttle')!} />
          )}
          {pair('brake') && <TraceChart {...shared} title="Brake" unit="" height={100} series={pair('brake')!} />}
          <Text style={StyleSheet.flatten([t.small, styles.measure])}>
            Above zero, L{lap} is behind the reference at that point. Drag across a chart to read values.
            {detected && markers.length > 0 ? ` ${DETECTED_CORNERS_NOTE}` : ''}
          </Text>
        </View>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  section: { gap: 14 },
  picks: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 10 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 8, alignItems: 'center' },
  at: { ...Type.number, fontSize: 13, color: c.textSecondary },
  left: { alignSelf: 'flex-start' },
  charts: { gap: 14 },
  measure: { maxWidth: 820 },
}));
