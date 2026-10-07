// Small pieces the prep pages (the Prep report, Quali prep, the official results) are built from, made only of the
// programme's parts (components/Programme.tsx) and tokens: figures in cells split by ink rules, a time difference in
// a flat block, a sub-head under a thick rule, a label beside its text, picks underlined like the masthead's links.
import { ReactNode, useState } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, TextInputProps, TextStyle, ViewStyle } from 'react-native';

import { useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { INK } from '@/constants/Colors';
import { deltaColor, face, Fonts, themed, Type, useTheme } from '@/constants/Theme';
import { noPrint } from '@/lib/print';

const EVEN_S = 0.005;

/** Ink or white for text on a filled colour: whichever has more contrast with it. */
export function onFill(fill: string): string {
  const lum = (h: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  if (!/^#[0-9a-f]{6}$/i.test(fill)) return INK.onLight;
  const f = lum(fill);
  const ratio = (t: string) => {
    const l = lum(t);
    return (Math.max(f, l) + 0.05) / (Math.min(f, l) + 0.05);
  };
  return ratio(INK.onLight) >= ratio(INK.onDark) ? INK.onLight : INK.onDark;
}

/** A value printed in a flat square block of colour (a table cell's colour coding). */
export function ValueBlock({ value, fill, bold, under, style }: { value: string; fill: string; bold?: boolean;
  under?: boolean; style?: ViewStyle }) {
  const styles = useStyles();
  return (
    <View style={StyleSheet.flatten([styles.vblock, { backgroundColor: fill }, under && styles.vblockUnder, style])}>
      <Text style={StyleSheet.flatten([styles.vblockText, bold && styles.vblockBold, { color: onFill(fill) }])}
        numberOfLines={1}>{value}</Text>
    </View>
  );
}

/** A signed time difference in seconds as a flat block: green quicker, red slower, grey even; a dash without one. */
export function DeltaBlock({ seconds, digits = 2, unit = true }: { seconds: number | null | undefined; digits?: number;
  unit?: boolean }) {
  const theme = useTheme();
  const styles = useStyles();
  if (seconds == null || !Number.isFinite(seconds)) return <Text style={styles.dash}>–</Text>;
  const sign = Math.abs(seconds) < EVEN_S ? '±' : seconds < 0 ? '−' : '+';
  return <ValueBlock value={`${sign}${Math.abs(seconds).toFixed(digits)}${unit ? ' s' : ''}`}
    fill={deltaColor(theme, seconds) ?? theme.delta.even} />;
}

/** Figures in cells side by side, split by thin ink rules, with a rule across the top of each row: `cols` across on a
 * wide screen, `phoneCols` on a phone. */
export function Cells({ children, cols, phoneCols = 2, style }: { children: ReactNode[]; cols?: number;
  phoneCols?: number; style?: ViewStyle }) {
  const styles = useStyles();
  const wide = useWide();
  const items = children.filter((c) => c != null && c !== false);
  const n = Math.max(1, wide ? cols ?? items.length : phoneCols);
  const rows: ReactNode[][] = [];
  for (let i = 0; i < items.length; i += n) rows.push(items.slice(i, i + n));
  return (
    <View style={style}>
      {rows.map((row, r) => (
        <View key={r} style={styles.cellRow}>
          {Array.from({ length: n }, (_, i) => (
            <View key={i} style={StyleSheet.flatten([styles.cell, wide ? null : styles.cellPhone, i === 0 && styles.cellFirst,
              i > 0 && row[i] != null && styles.cellRule])}>
              {row[i] ?? null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** A heading inside a section: a thick ink rule, the words in Anton, and an action or a fact on the right. */
export function SubHead({ title, kicker, right, style }: { title: string; kicker?: string; right?: ReactNode;
  style?: ViewStyle }) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={StyleSheet.flatten([styles.subHead, style])}>
      <View style={styles.subWords}>
        {kicker ? <Text style={styles.kicker}>{kicker}</Text> : null}
        <Text style={wide ? styles.subTitle : styles.subTitlePhone} accessibilityRole="header">{title}</Text>
      </View>
      {right ? <View style={styles.subRight}>{right}</View> : null}
    </View>
  );
}

/** A label in Archivo capitals beside its text (above it on a phone), over a faint rule. */
export function Item({ label, children, first }: { label: string; children: ReactNode; first?: boolean }) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={StyleSheet.flatten([wide ? styles.item : styles.itemPhone, first && styles.itemFirst])}>
      {label ? <Text style={wide ? styles.itemLabel : styles.itemLabelPhone}>{label}</Text>
        : wide ? <View style={styles.itemLabel} /> : null}
      <View style={styles.itemBody}>{children}</View>
    </View>
  );
}

/** One of a few choices in Archivo capitals, the picked one underlined in red (like the masthead's links). */
export function Pick({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const styles = useStyles();
  return (
    // on paper only the picked one is left
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress} hitSlop={6}
      {...(on ? null : noPrint)} style={StyleSheet.flatten([styles.pick, on && styles.pickOn])}>
      <Text style={StyleSheet.flatten([styles.pickText, !on && styles.pickOff])}>{label}</Text>
    </Pressable>
  );
}

/** A square field for a short figure (a car number): Archivo figures over a single ink rule, which turns red and
 * heavier while the field has the focus (in place of the browser's rounded focus ring). */
export function Field({ width = 96, style, onFocus, onBlur, ...rest }: TextInputProps & { width?: number }) {
  const styles = useStyles();
  const theme = useTheme();
  const [focus, setFocus] = useState(false);
  return (
    <TextInput placeholderTextColor={theme.textMuted} {...rest}
      onFocus={(e) => {
        setFocus(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocus(false);
        onBlur?.(e);
      }}
      style={StyleSheet.flatten([styles.field, { width }, focus && styles.fieldFocus, style])} />
  );
}

/** The text styles the prep pages share: reading text, the small italic note, a small label line. */
export const usePrepType = themed((c) => ({
  read: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 25, color: c.text } as TextStyle,
  readPhone: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text } as TextStyle,
  lead: { fontFamily: Fonts.body, fontSize: 20, lineHeight: 29, color: c.text } as TextStyle,
  leadPhone: { fontFamily: Fonts.body, fontSize: 18, lineHeight: 26, color: c.text } as TextStyle,
  strong: { fontFamily: face('body', 700), color: c.text } as TextStyle,
  inLabel: { ...Type.label, fontFamily: face('label', 700), fontSize: 13, letterSpacing: 1.2, color: c.text } as TextStyle,
  note: { fontFamily: face('body', 400, true), fontSize: 15, lineHeight: 21, color: c.textSecondary } as TextStyle,
  small: { fontFamily: face('label', 500), fontSize: 13, lineHeight: 18, letterSpacing: 0.2, color: c.textSecondary } as TextStyle,
  num: { fontFamily: face('label', 600), fontVariant: ['tabular-nums'], color: c.text } as TextStyle,
  error: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.error } as TextStyle,
}));

const useStyles = themed((c) => ({
  // no alignSelf: the cell it sits in places it (a column of figures aligns it right)
  vblock: { paddingHorizontal: 6, paddingTop: 2, paddingBottom: 1 },
  vblockUnder: { borderBottomWidth: 3, borderColor: c.rule, paddingBottom: 0 },
  vblockText: { fontFamily: face('label', 600), fontSize: 14, fontVariant: ['tabular-nums'] },
  vblockBold: { fontFamily: face('label', 700) },
  dash: { fontFamily: face('label', 600), fontSize: 14, color: c.textMuted },

  cellRow: { flexDirection: 'row', borderTopWidth: 1, borderColor: c.rule },
  cell: { flex: 1, minWidth: 0, paddingTop: 12, paddingBottom: 16, paddingHorizontal: 16 },
  cellPhone: { paddingHorizontal: 12 },
  cellFirst: { paddingLeft: 0 },
  cellRule: { borderLeftWidth: 1, borderColor: c.rule },

  subHead: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
    borderTopWidth: 3, borderColor: c.rule, paddingTop: 8, marginBottom: 12 },
  subWords: { flexShrink: 1, minWidth: 0 },
  kicker: { ...Type.label, fontFamily: face('label', 700), fontSize: 12, color: c.textSecondary, marginBottom: 3 },
  subTitle: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 31, textTransform: 'uppercase', color: c.text },
  subTitlePhone: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 27, textTransform: 'uppercase', color: c.text },
  subRight: { paddingBottom: 3 },

  item: { flexDirection: 'row', gap: 24, borderTopWidth: 1, borderColor: c.separator, paddingTop: 11, paddingBottom: 12 },
  itemPhone: { borderTopWidth: 1, borderColor: c.separator, paddingTop: 10, paddingBottom: 11, gap: 5 },
  itemFirst: { borderTopWidth: 1, borderColor: c.rule },
  itemLabel: { ...Type.label, fontFamily: face('label', 700), fontSize: 13, letterSpacing: 1.3, width: 210, paddingTop: 3,
    color: c.text },
  itemLabelPhone: { ...Type.label, fontFamily: face('label', 700), fontSize: 12, letterSpacing: 1.2, color: c.text },
  itemBody: { flex: 1, minWidth: 0, gap: 6 },

  field: { fontFamily: face('label', 600), fontSize: 20, fontVariant: ['tabular-nums'], color: c.text,
    borderBottomWidth: 2, borderColor: c.rule, paddingHorizontal: 2, paddingTop: 8, paddingBottom: 8, minHeight: 44, borderRadius: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) } as TextStyle,
  fieldFocus: { borderBottomWidth: 3, paddingBottom: 7, borderColor: c.mark },

  pick: { paddingBottom: 3, borderBottomWidth: 3, borderColor: 'transparent' },
  pickOn: { borderColor: c.mark },
  pickText: { ...Type.label, fontFamily: face('label', 700), fontSize: 14, letterSpacing: 1.4, color: c.text },
  pickOff: { color: c.textMuted },
}));
