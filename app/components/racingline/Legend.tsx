// What the 3D view's marks mean: each lap's line (colour and pattern), the four marker shapes, the tyre load columns
// (deeper and taller with more load) and the slip arrow.
import Svg, { Circle, Line, Polygon, Rect } from 'react-native-svg';

import { Text, View } from '@/components/Themed';
import { LapKey, MARKER_NAMES, MarkerKind, MarkerShape } from '@/components/racingline/LapKey';
import { LOAD_TICKS, loadColor, loadShare, useScenePalette } from '@/components/racingline/colors';
import { Fonts, themed, useTheme } from '@/constants/Theme';
import type { RacingLine } from '@/lib/racingLine';
import { PATTERNS } from '@/lib/racingLineMath';

export function Legend({ data, colors }: { data: RacingLine; colors: string[] }) {
  const styles = useStyles();
  const c = useTheme();
  const pal = useScenePalette();
  return (
    <View style={styles.box}>
      <View style={styles.row}>
        {data.laps.map((l, k) => (
          <View key={l.key} style={styles.item}>
            <LapKey k={k} color={colors[k % colors.length]} />
            <Text style={styles.text}>{`${l.label}, ${PATTERNS[k % PATTERNS.length].name}${k === 0 ? ', solid car' : ', ghost car'}`}</Text>
          </View>
        ))}
      </View>
      <View style={styles.row}>
        {(Object.keys(MARKER_NAMES) as MarkerKind[]).map((k) => (
          <View key={k} style={styles.item}>
            <MarkerShape kind={k} />
            <Text style={styles.text}>{MARKER_NAMES[k]}</Text>
          </View>
        ))}
      </View>
      <View style={styles.row}>
        <View style={styles.item}>
          <Svg width={54} height={30} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {[60, 100, 160].map((pct, i) => {
              const s = loadShare(pct);
              const hgt = 4 + s * 24, wid = 6 + s * 8;
              return <Rect key={pct} x={2 + i * 18} y={29 - hgt} width={wid} height={hgt} fill={loadColor(pal, pct)}
                stroke={c.text} strokeWidth={1} />;
            })}
          </Svg>
          <Text style={styles.text}>Tyre load column: taller and wider with more load</Text>
        </View>
        <View style={styles.item}>
          <Svg width={30} height={30} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Line x1={15} x2={15} y1={3} y2={27} stroke={c.textMuted} strokeWidth={2} />
            <Line x1={3} x2={27} y1={15} y2={15} stroke={c.textMuted} strokeWidth={2} />
            <Circle cx={20} cy={10} r={6} fill={c.text} stroke={c.background} strokeWidth={2} />
          </Svg>
          <Text style={styles.text}>Bird view: the dot is where the car’s load sits, the cross where it sits at rest</Text>
        </View>
        <View style={styles.item}>
          <Svg width={34} height={16} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Line x1={2} x2={24} y1={8} y2={8} stroke={pal.arrow} strokeWidth={3} />
            <Polygon points="22,2 32,8 22,14" fill={pal.arrow} />
          </Svg>
          <Text style={styles.text}>Where the car travels, shown when it slides more than 1°</Text>
        </View>
      </View>
      <View style={styles.scale} accessible
        accessibilityLabel="Load scale, as a share of each tyre's static load: 50 percent lightest and narrowest, 100, 150, 200 percent deepest and widest">
        <Text style={styles.scaleTitle}>Tyre load, % of static (trails, tyres, columns)</Text>
        <View style={styles.ticks}>
          {LOAD_TICKS.map((pct) => (
            <View key={pct} style={styles.tick}>
              <View style={{ width: 40, height: 6 + loadShare(pct) * 14, backgroundColor: loadColor(pal, pct) }} />
              <Text style={styles.tickText}>{`${pct} %`}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { gap: 8, borderTopWidth: 1, borderColor: c.separator, paddingTop: 10 },
  row: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 6 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  scale: { gap: 4 },
  scaleTitle: { fontFamily: Fonts.label, fontSize: 13, letterSpacing: 1.2, textTransform: 'uppercase', color: c.text },
  ticks: { flexDirection: 'row', gap: 10, alignItems: 'flex-end' },
  tick: { gap: 3, alignItems: 'flex-start' },
  tickText: { fontFamily: Fonts.label, fontSize: 16, color: c.text },
  text: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.textSecondary, flexShrink: 1 },
}));
