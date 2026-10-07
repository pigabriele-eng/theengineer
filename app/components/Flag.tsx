// An event's country as a timing screen shows it: the flag, drawn from the geometry in lib/countries.ts, and the three
// letters (GER, NED, FRA). The plate is the flag 3:2 inside a hairline ink edge, square-cornered; CountryTag sets it
// before an event's name, HeroCountry first in a photo hero's kicker. Never emoji flags: Windows shows them as letters.
import Svg, { Circle, Line, Polygon, Rect } from 'react-native-svg';

import { useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { themed, Type, useTheme } from '@/constants/Theme';
import { Country, FLAG_H, FLAG_W, FlagShape } from '@/lib/countries';

const PHOTO_INK = '#F7F4EC'; // text on a photo, in both schemes (as components/Programme.tsx)

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

/** The flag drawn on its board, `width` wide and two thirds of that high, inside a hairline edge (ink on the paper,
 * so a white or a black band still has an edge in either scheme). */
export function FlagPlate({ country, width, edge }: { country: Country; width: number; edge?: string }) {
  const c = useTheme();
  const height = Math.round((width * FLAG_H) / FLAG_W);
  return (
    <View accessible accessibilityLabel={`Flag of ${country.name}`}
      style={{ borderWidth: 1, borderColor: edge ?? c.rule, alignSelf: 'flex-start' }}>
      <Svg width={width} height={height} viewBox={`0 0 ${FLAG_W} ${FLAG_H}`} preserveAspectRatio="none">
        {country.shapes.map((s, i) => <Shape key={i} s={s} />)}
      </Svg>
    </View>
  );
}

/** The plate and the three letters, set before an event's name in a list. */
export function CountryTag({ country }: { country: Country }) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={styles.tag}>
      <FlagPlate country={country} width={wide ? 42 : 33} />
      <Text style={wide ? styles.code : styles.codePhone}>{country.code}</Text>
    </View>
  );
}

/** The plate and the three letters in a box, first in a photo hero's kicker (Hero's badge). */
export function HeroCountry({ country }: { country: Country }) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={styles.hero}>
      <FlagPlate country={country} width={wide ? 45 : 36} edge="rgba(247,244,236,0.85)" />
      <View style={styles.heroCode}><Text style={styles.heroCodeText}>{country.code}</Text></View>
    </View>
  );
}

const useStyles = themed((c) => ({
  tag: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  code: { ...Type.label, fontSize: 16, letterSpacing: 1.8, color: c.text },
  codePhone: { ...Type.label, fontSize: 14, letterSpacing: 1.6, color: c.text },
  hero: { flexDirection: 'row', alignItems: 'stretch', marginRight: 10 },
  heroCode: { justifyContent: 'center', borderWidth: 1, borderLeftWidth: 0, borderColor: 'rgba(247,244,236,0.85)',
    backgroundColor: 'rgba(10,10,10,0.6)', paddingHorizontal: 10 }, // a scrim as dark as the kicker's: reads on any photo
  heroCodeText: { ...Type.label, fontSize: 15, letterSpacing: 2, color: PHOTO_INK },
}));
