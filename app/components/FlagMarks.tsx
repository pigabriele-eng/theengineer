// TEMPORARY: four ways of setting an event's country in its title on the home page, to pick one from. The home page
// shows one with ?flags=a|b|c|d and none without; the three not picked go, with the switch.
//   a  Margin stripe: a thick band in the national colours down the left edge of the event's row (and the hero's).
//   b  Flag plate: the drawn flag and the timing screen's three letters (GER, NED, FRA) before the event's name
//      (and leading the hero's kicker).
//   c  Tricolour rule: the rule above the event's row in the national colours, the three letters in the date column
//      (and the rule under the hero, the three letters first in its folio).
//   d  Number board: the dates set on a paper plate on a board filled with the flag, like a race number board (and a
//      big one over the hero's kicker).
import { ReactNode } from 'react';
import { StyleSheet, ViewStyle } from 'react-native';

import { ColourBands, FlagFill, FlagPlate } from '@/components/Flag';
import { useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { Fonts, themed, Type, useTheme } from '@/constants/Theme';
import { Country } from '@/lib/countries';

export type FlagLook = 'a' | 'b' | 'c' | 'd';

/** The look the page's ?flags= asks for, else none. */
export function flagLook(param: string | string[] | undefined): FlagLook | null {
  const v = (Array.isArray(param) ? param[0] : param)?.toLowerCase();
  return v === 'a' || v === 'b' || v === 'c' || v === 'd' ? v : null;
}

const PHOTO_INK = '#F7F4EC'; // text on a photo, in both schemes (as components/Programme.tsx)

// ---------- the hero ----------

/** Round the hero: the margin stripe down its left edge (a), the tricolour rule under it (c). */
export function HeroFrame({ look, country, children }: { look: FlagLook | null; country: Country | null;
  children: ReactNode }) {
  const wide = useWide();
  const c = useTheme();
  if (!country || (look !== 'a' && look !== 'c')) return <>{children}</>;
  if (look === 'a') {
    return (
      <View style={{ position: 'relative' }}>
        {children}
        <ColourBands country={country} dir="down" style={{ position: 'absolute', left: 0, top: 0, bottom: 0,
          width: wide ? 16 : 9 }} />
      </View>
    );
  }
  return (
    <>
      {children}
      <ColourBands country={country} dir="across" edge={c.rule} style={{ height: wide ? 11 : 9 }} />
    </>
  );
}

/** What the hero sets with its title: the flag plate leading the kicker (b), the number board over it (d). */
export function HeroBadge({ look, country, board }: { look: FlagLook | null; country: Country | null; board: string }) {
  const styles = useStyles();
  const wide = useWide();
  if (look === 'b' && country) {
    return (
      <View style={styles.heroPlate}>
        <View style={styles.heroPlateEdge}><FlagPlate country={country} width={wide ? 45 : 36} edge={false} /></View>
        <View style={styles.heroCode}><Text style={styles.heroCodeText}>{country.code}</Text></View>
      </View>
    );
  }
  if (look === 'd') {
    return (
      <Board country={country} pad={wide ? 8 : 6} onPhoto>
        <Text style={wide ? styles.heroBoardText : styles.heroBoardTextPhone}>{board}</Text>
      </Board>
    );
  }
  return null;
}

// ---------- an event's row ----------

/** The band down the row's left edge (a): the row makes room for it. */
export function RowStripe({ country }: { country: Country | null }) {
  const c = useTheme();
  const wide = useWide();
  const style: ViewStyle = { position: 'absolute', left: 0, top: 0, bottom: 0, width: wide ? 11 : 8 };
  return country ? <ColourBands country={country} dir="down" edge={c.rule} style={style} />
    : <View style={StyleSheet.flatten([style, { backgroundColor: c.fill }])} />;
}

/** The row's left padding that makes room for the stripe (a). */
export const useStripeRoom = () => (useWide() ? 26 : 18);

/** The rule above the row in the national colours (c); in ink when the country isn't known. */
export function RowRule({ country }: { country: Country | null }) {
  const c = useTheme();
  const wide = useWide();
  const style: ViewStyle = { height: wide ? 8 : 7, marginBottom: wide ? 13 : 11 };
  return country ? <ColourBands country={country} dir="across" edge={c.rule} style={style} />
    : <View style={StyleSheet.flatten([style, { backgroundColor: c.rule }])} />;
}

/** The three letters under the date (c, on a desktop) or before it (c, on a phone). */
export function RowCode({ country }: { country: Country | null }) {
  const styles = useStyles();
  const wide = useWide();
  if (!country) return null;
  return <Text style={wide ? styles.rowCode : styles.rowCodePhone}>{country.code}</Text>;
}

/** The flag plate and the three letters before the name (b). */
export function NamePlate({ country }: { country: Country | null }) {
  const styles = useStyles();
  const wide = useWide();
  if (!country) return null;
  return (
    <View style={styles.namePlate}>
      <FlagPlate country={country} width={wide ? 42 : 33} />
      <Text style={wide ? styles.nameCode : styles.nameCodePhone}>{country.code}</Text>
    </View>
  );
}

/** The dates on the number board (d). */
export function DateBoard({ country, dates }: { country: Country | null; dates: string }) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <Board country={country} pad={wide ? 7 : 5}>
      <Text style={wide ? styles.boardText : styles.boardTextPhone}>{dates}</Text>
    </Board>
  );
}

/** A board filled with the flag (in ink when the country isn't known) with a paper plate on it. */
function Board({ country, pad, onPhoto, children }: { country: Country | null; pad: number; onPhoto?: boolean;
  children: ReactNode }) {
  const c = useTheme();
  return (
    <View style={{ alignSelf: 'flex-start', padding: pad, position: 'relative',
      backgroundColor: country ? undefined : onPhoto ? '#111111' : c.rule }}>
      {country ? <FlagFill country={country} /> : null}
      <View style={{ backgroundColor: onPhoto ? PHOTO_INK : c.background, paddingHorizontal: pad + 4,
        paddingTop: pad - 1, paddingBottom: pad - 2 }}>
        {children}
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  heroPlate: { flexDirection: 'row', alignItems: 'stretch', marginRight: 10 },
  heroPlateEdge: { borderWidth: 1, borderColor: 'rgba(247,244,236,0.85)' },
  heroCode: { justifyContent: 'center', borderWidth: 1, borderLeftWidth: 0, borderColor: 'rgba(247,244,236,0.85)',
    backgroundColor: 'rgba(10,10,10,0.35)', paddingHorizontal: 10 },
  heroCodeText: { ...Type.label, fontSize: 15, letterSpacing: 2, color: PHOTO_INK },
  heroBoardText: { fontFamily: Fonts.display, fontSize: 44, lineHeight: 46, textTransform: 'uppercase', color: '#111111' },
  heroBoardTextPhone: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 30, textTransform: 'uppercase',
    color: '#111111' },

  rowCode: { ...Type.label, fontSize: 14, letterSpacing: 2, color: c.textSecondary, marginTop: 8 },
  rowCodePhone: { ...Type.label, fontSize: 15, letterSpacing: 1.8, color: c.textSecondary },
  namePlate: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  nameCode: { ...Type.label, fontSize: 16, letterSpacing: 1.8, color: c.text },
  nameCodePhone: { ...Type.label, fontSize: 14, letterSpacing: 1.6, color: c.text },
  boardText: { fontFamily: Fonts.display, fontSize: 27, lineHeight: 29, textTransform: 'uppercase', color: c.text },
  boardTextPhone: { ...Type.label, fontSize: 15, letterSpacing: 1.8, color: c.text },
}));
