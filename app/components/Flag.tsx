// A country's flag, drawn from the geometry in lib/countries.ts: the plate (the flag 3:2 with a hairline ink edge, as
// a timing screen shows it), the flag stretched to fill a block, and the national colours as bands for a stripe or a
// rule. Square edges only. Never emoji flags: Windows shows them as two letters.
import { StyleSheet, ViewStyle } from 'react-native';
import Svg, { Circle, Line, Polygon, Rect } from 'react-native-svg';

import { View } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';
import { Country, FLAG_H, FLAG_W, FlagShape } from '@/lib/countries';

function Shape({ s }: { s: FlagShape }) {
  if ('rect' in s) {
    const [x, y, width, height] = s.rect;
    // a hair over the band's height: no seam of paper between two bands
    return <Rect x={x} y={y} width={width + 0.02} height={height + 0.02} fill={s.fill} />;
  }
  if ('poly' in s) return <Polygon points={s.poly.join(',')} fill={s.fill} />;
  if ('line' in s) {
    const [x1, y1, x2, y2] = s.line;
    return <Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={s.stroke} strokeWidth={s.width} />;
  }
  const [cx, cy, r] = s.circle;
  return <Circle cx={cx} cy={cy} r={r} fill={s.fill ?? 'none'} stroke={s.stroke} strokeWidth={s.width} />;
}

/** The flag drawn on its board, `width` wide and two thirds of that high, inside a hairline ink edge (so a white or a
 * black band still has an edge on the paper of either scheme). */
export function FlagPlate({ country, width, edge = true }: { country: Country; width: number; edge?: boolean }) {
  const c = useTheme();
  const height = Math.round((width * FLAG_H) / FLAG_W);
  return (
    <View accessible accessibilityLabel={`Flag of ${country.name}`} style={{ borderWidth: edge ? 1 : 0,
      borderColor: c.rule, alignSelf: 'flex-start', backgroundColor: c.background }}>
      <Svg width={width} height={height} viewBox={`0 0 ${FLAG_W} ${FLAG_H}`} preserveAspectRatio="none">
        {country.shapes.map((s, i) => <Shape key={i} s={s} />)}
      </Svg>
    </View>
  );
}

/** The flag stretched over the whole of its parent (which sets the size), behind what is set on it. */
export function FlagFill({ country }: { country: Country }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill as ViewStyle}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${FLAG_W} ${FLAG_H}`} preserveAspectRatio="none">
        {country.shapes.map((s, i) => <Shape key={i} s={s} />)}
      </Svg>
    </View>
  );
}

/** The national colours as bands, in their shares: stacked top to bottom (`down`, a stripe) or side by side (`across`,
 * a rule), with a hairline `edge` when given (a white band on light paper, a black one on dark). The parent sets the
 * size. */
export function ColourBands({ country, dir, edge, style }: { country: Country; dir: 'down' | 'across'; edge?: string;
  style?: ViewStyle }) {
  const weights = country.weights ?? country.colors.map(() => 1);
  return (
    <View pointerEvents="none" style={StyleSheet.flatten([{ flexDirection: dir === 'down' ? 'column' : 'row' },
      edge ? { borderWidth: 1, borderColor: edge } : null, style])}>
      {country.colors.map((color, i) => (
        <View key={i} style={{ flex: weights[i], backgroundColor: color }} />
      ))}
    </View>
  );
}
