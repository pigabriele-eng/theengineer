// The numbers beside the 3D view, one panel per lap, at the playhead: the lap's key and label, its speed and gear, the
// throttle and the brake as bars with their numbers, the steering and the slip angle, how far its line is from the
// first lap's ("0.8 m further left") and how far behind or ahead it is, and its four tyre loads in a 2 x 2 grid laid
// out like the car (front on top). Text and bars, never colour alone; a screen reader reads every figure.
import { StyleSheet } from 'react-native';

import { Meter } from '@/components/Picks';
import { Text, View } from '@/components/Themed';
import { LapKey } from '@/components/racingline/LapKey';
import { loadColor, loadShare, useScenePalette } from '@/components/racingline/colors';
import { Fonts, themed, Type, useTheme } from '@/constants/Theme';
import { RacingLine, Wheel } from '@/lib/racingLine';
import { centreWords, lateralWords, loadCentre, sample, slipWords, steerWords, Sync } from '@/lib/racingLineMath';

const GRID: Wheel[][] = [['fl', 'fr'], ['rl', 'rr']];

export function Hud({ data, colors, places, sync, columns = 1 }: {
  data: RacingLine;
  colors: string[];
  places: number[];
  sync: Sync;
  columns?: number;
}) {
  const styles = useStyles();
  const c = useTheme();
  const pal = useScenePalette();
  const first = data.laps[0];
  const f0 = places[0] ?? 0;
  return (
    <View style={StyleSheet.flatten([styles.list, columns > 1 && styles.listCols])}>
      {data.laps.map((lap, k) => {
        const f = places[k] ?? 0;
        const color = colors[k % colors.length];
        const v = (a: number[]) => sample(a, f);
        const speed = v(lap.speed);
        const thr = Math.max(0, Math.min(100, v(lap.throttle)));
        const brk = Math.max(0, Math.min(100, v(lap.brake)));
        const lat = v(lap.lateral);
        const vsFirst = k === 0 ? null : lat - sample(first.lateral, f0);
        // behind or ahead of the first lap: in time at the same place, in metres at the same time
        const gap = k === 0 ? null : sync === 'place'
          ? `${(v(lap.t) - sample(first.t, f0)) >= 0 ? '+' : '−'}${Math.abs(v(lap.t) - sample(first.t, f0)).toFixed(2)} s here`
          : (() => {
            const dm = (f - f0) * data.step_m;
            return Math.abs(dm) < 0.5 ? 'level' : `${Math.abs(dm).toFixed(0)} m ${dm < 0 ? 'behind' : 'ahead'}`;
          })();
        return (
          <View key={lap.key} style={StyleSheet.flatten([styles.panel, { borderTopColor: color },
            columns > 1 && { width: `${100 / columns - 2}%` as const }])}>
            <View style={styles.head}>
              <LapKey k={k} color={color} />
              <Text style={styles.name} numberOfLines={2}>{lap.label}</Text>
              <Text style={styles.small}>{k === 0 ? 'first: the others are compared with it' : `${gap}`}</Text>
            </View>
            <View style={styles.figs}>
              <Text style={styles.big}>{Math.round(speed)}<Text style={styles.unit}> km/h</Text></Text>
              <Text style={styles.big}>{Math.round(v(lap.gear))}<Text style={styles.unit}> gear</Text></Text>
            </View>
            <Bar label="Throttle" value={thr} color={c.phase.throttle} />
            <Bar label="Brake" value={brk} color={c.phase.braking} />
            <Line label="Steering" value={steerWords(v(lap.steer))} />
            <Line label="Slip" value={slipWords(v(lap.slip_deg))} />
            {vsFirst != null && <Line label="Line" value={lateralWords(vsFirst)} />}
            <Line label="Load centre" value={centreWords(loadCentre({ fl: v(lap.load.fl), fr: v(lap.load.fr),
              rl: v(lap.load.rl), rr: v(lap.load.rr) }))} />
            <View style={styles.car} accessibilityLabel={`Tyre loads: ${GRID.flat().map((w) =>
              `${w.toUpperCase()} ${Math.round(v(lap.load[w]))} percent`).join(', ')}`} accessible>
              <Text style={styles.front}>Front · tyre load, % of static</Text>
              {GRID.map((row) => (
                <View key={row.join()} style={styles.axle}>
                  {row.map((w) => {
                    const pct = v(lap.load[w]);
                    return (
                      <View key={w} style={styles.wheel}>
                        <View style={styles.wheelHead}>
                          <Text style={styles.wheelName}>{w.toUpperCase()}</Text>
                          <Text style={styles.wheelNum}>{`${Math.round(pct)} %`}</Text>
                        </View>
                        <Meter share={loadShare(pct)} color={loadColor(pal, pct)} height={8} />
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  const styles = useStyles();
  return (
    <View style={styles.bar}>
      <View style={styles.barHead}>
        <Text style={styles.lineLabel}>{label}</Text>
        <Text style={styles.lineValue}>{`${Math.round(value)} %`}</Text>
      </View>
      <Meter share={value / 100} color={color} height={8} />
    </View>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={styles.lineValue}>{value}</Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  list: { gap: 12 },
  listCols: { flexDirection: 'row', flexWrap: 'wrap', columnGap: '4%' },
  panel: { borderWidth: 1, borderColor: c.border, borderTopWidth: 4, padding: 10, gap: 8 },
  head: { gap: 4 },
  name: { ...Type.label, fontSize: 15, color: c.text },
  small: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 21, color: c.textSecondary },
  figs: { flexDirection: 'row', columnGap: 18, flexWrap: 'wrap' },
  big: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 32, color: c.text },
  unit: { fontFamily: Fonts.label, fontSize: 14, color: c.textSecondary },
  bar: { gap: 3 },
  barHead: { flexDirection: 'row', justifyContent: 'space-between' },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, borderTopWidth: 1, borderColor: c.separator,
    paddingTop: 4 },
  lineLabel: { ...Type.label, fontSize: 13, color: c.textMuted },
  lineValue: { ...Type.number, fontSize: 16, color: c.text, flexShrink: 1, textAlign: 'right' },
  car: { borderWidth: 1, borderColor: c.rule, padding: 8, gap: 8 },
  front: { ...Type.label, fontSize: 13, color: c.textMuted, textAlign: 'center' },
  axle: { flexDirection: 'row', gap: 16 },
  wheel: { flex: 1, gap: 3 },
  wheelHead: { flexDirection: 'row', justifyContent: 'space-between' },
  wheelName: { ...Type.label, fontSize: 13, color: c.text },
  wheelNum: { ...Type.number, fontSize: 16, color: c.text },
}));
