// The engineering tools' forms in the race programme's look, built from components/Programme.tsx: the page's opening
// headline, a field (an Archivo label over a square input on an ink rule, figures in tabular Archivo), a spec-sheet
// line (a name on the left, its inputs on the right), options (capitals, the picked one over a red underline), the
// main action (a square ink block with paper text), the four tyres laid out as the car seen from above, and the
// table and note styles the tools share. Square edges, ink rules, colour only as flat blocks and underlines.
import { Children, isValidElement, ReactNode, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  TextInputProps,
  TextStyle,
  ViewStyle,
} from 'react-native';

import { Block, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { noPrint } from '@/lib/print';
import { Corner } from '@/lib/tyres';
import { face, Fonts, tapRoom, themed, Type, useTheme } from '@/constants/Theme';

// ---------- the page's opening ----------

/** A tool's opening: its name as the headline (the page has no photo), the italic line under it, then `children`
 * (the Print link). */
export function Opening({ title, dek, children }: { title: string; dek?: ReactNode; children?: ReactNode }) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={wide ? styles.opening : styles.openingPhone}>
      <Text style={wide ? styles.title : styles.titlePhone} accessibilityRole="header">{title}</Text>
      {dek ? <Text style={wide ? styles.dek : styles.dekPhone}>{dek}</Text> : null}
      {children ? <View style={styles.openingMore}>{children}</View> : null}
    </View>
  );
}

// ---------- inputs ----------

type FieldProps = Omit<TextInputProps, 'style'> & {
  label?: string; // Archivo capitals above the input
  unit?: string; // after the label, muted
  note?: string; // under the input, muted (a source, "needed")
  width?: number; // a fixed width (an input in a sheet row); else it fills its place
  align?: 'left' | 'right' | 'center';
  warn?: boolean; // a value still needed: the rule turns to the warning colour
  marked?: boolean; // changed from before: the rule in red
  boxed?: boolean; // a thin ink box instead of the rule (several lines of text)
  small?: boolean;
  style?: ViewStyle;
  inputStyle?: TextStyle;
};

/** A field: its label in Archivo capitals above a square input on a single ink rule (red while typing in it), the
 * figures in tabular Archivo. `boxed` draws a thin ink box instead, for text over several lines. */
export function Field({ label, unit, note, width, align, warn, marked, boxed, small, style, inputStyle, onFocus, onBlur,
  ...input }: FieldProps) {
  const styles = useStyles();
  const c = useTheme();
  const [focus, setFocus] = useState(false);
  const box = StyleSheet.flatten([
    boxed || input.multiline ? styles.boxed : small ? styles.inputSmall : styles.input,
    warn && styles.inputWarn,
    marked && styles.inputMarked,
    focus && styles.inputFocus,
    width != null ? { width } : null,
    align ? { textAlign: align } : null,
    inputStyle,
  ]);
  return (
    <View style={StyleSheet.flatten([width != null ? null : styles.fieldFill, style])}>
      {label ? (
        <Text style={styles.fieldLabel}>
          {label}
          {unit ? <Text style={styles.fieldUnit}>{` ${unit}`}</Text> : null}
        </Text>
      ) : null}
      <TextInput
        placeholderTextColor={c.textMuted}
        keyboardType="numbers-and-punctuation"
        {...input}
        accessibilityLabel={input.accessibilityLabel ?? (label ? `${label}${unit ? ` ${unit}` : ''}` : undefined)}
        onFocus={(e) => {
          setFocus(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocus(false);
          onBlur?.(e);
        }}
        style={box}
      />
      {note ? <Text style={StyleSheet.flatten([styles.fieldNote, warn && styles.warnText])}>{note}</Text> : null}
    </View>
  );
}

/** Fields side by side, `columns` across (each takes its share and wraps under the others past it). */
export function FieldGrid({ columns, children, style }: { columns: number; children: ReactNode; style?: ViewStyle }) {
  const styles = useStyles();
  const items = (Array.isArray(children) ? children : [children]).flat().filter((x) => x != null && x !== false);
  return (
    <View style={StyleSheet.flatten([styles.grid, style])}>
      {items.map((child, i) => (
        <View key={i} style={{ width: `${100 / columns}%`, paddingRight: (i + 1) % columns === 0 ? 0 : 16 }}>
          {child as ReactNode}
        </View>
      ))}
    </View>
  );
}

/** A line of a spec sheet: the name (and its unit, its source) on the left, its inputs on the right, over a faint
 * rule; `note` runs the full width under it. */
export function SheetRow({ label, sub, note, children, warn }: {
  label: string;
  sub?: string;
  note?: string | null;
  children?: ReactNode;
  warn?: boolean;
}) {
  const styles = useStyles();
  return (
    <View style={styles.sheetRow}>
      <View style={styles.sheetLine}>
        <View style={styles.sheetName}>
          <Text style={styles.sheetLabel}>{label}</Text>
          {sub ? <Text style={StyleSheet.flatten([styles.sheetSub, warn && styles.warnText])}>{sub}</Text> : null}
        </View>
        {children}
      </View>
      {note ? <Text style={styles.sheetNote}>{note}</Text> : null}
    </View>
  );
}

/** A setting that goes up and down in steps: − the value +, square, the figures tabular. */
export function Stepper({ value, of, onStep, label }: { value: string; of?: string; onStep: (d: number) => void;
  label: string }) {
  const styles = useStyles();
  return (
    <View style={styles.stepper}>
      <Pressable onPress={() => onStep(-1)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${label} down`}
        style={styles.stepHit} {...noPrint}>
        <View style={styles.stepKey}>
          <Text style={styles.stepKeyText}>−</Text>
        </View>
      </Pressable>
      <Text style={styles.stepValue}>
        {value}
        {of ? <Text style={styles.stepOf}>{of}</Text> : null}
      </Text>
      <Pressable onPress={() => onStep(1)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${label} up`}
        style={styles.stepHit} {...noPrint}>
        <View style={styles.stepKey}>
          <Text style={styles.stepKeyText}>+</Text>
        </View>
      </Pressable>
    </View>
  );
}

// ---------- picking ----------

export type Option<T> = { value: T; label: string; sub?: string; muted?: boolean };

/** Options to pick from, in capitals: the picked one in ink over a red underline, the others grey. `big` sets them in
 * Anton (a page's modes); `multi` picks several, each with a square box that fills in ink. */
export function Options<T extends string | number>({ options, value, onPick, multi, big, label, disabled }: {
  options: Option<T>[];
  value: T | T[] | null;
  onPick: (v: T) => void;
  multi?: boolean;
  big?: boolean;
  label?: string; // what the options pick, for screen readers
  disabled?: boolean;
}) {
  const styles = useStyles();
  const wide = useWide();
  const isOn = (v: T) => (Array.isArray(value) ? value.includes(v) : value === v);
  return (
    <View style={big ? (wide ? styles.bigOptions : styles.bigOptionsPhone) : styles.options}
      accessibilityRole={multi ? undefined : big ? 'tablist' : 'radiogroup'} accessibilityLabel={label}>
      {options.map((o) => {
        const on = isOn(o.value);
        if (multi) {
          return (
            // on paper only the ticked and the picked options are left
            <Pressable key={String(o.value)} onPress={() => onPick(o.value)} disabled={disabled} hitSlop={4}
              accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled }} {...(on ? null : noPrint)}
              style={StyleSheet.flatten([styles.check, o.sub ? styles.checkHitSub : styles.checkHit,
                disabled && styles.dim])}>
              <View style={StyleSheet.flatten([styles.checkBox, on && styles.checkBoxOn])} />
              <View style={styles.optionWords}>
                <Text style={StyleSheet.flatten([styles.optionText, on && styles.optionTextOn])}>{o.label}</Text>
                {o.sub ? <Text style={styles.optionSub}>{o.sub}</Text> : null}
              </View>
            </Pressable>
          );
        }
        // the pressable is the 44 px tap target round the drawn option (its underline on the inner view)
        return (
          <Pressable key={String(o.value)} onPress={() => onPick(o.value)} disabled={disabled} hitSlop={4}
            accessibilityRole={big ? 'tab' : 'radio'} {...(on ? null : noPrint)}
            accessibilityState={big ? { selected: on, disabled } : { checked: on, disabled }}
            style={StyleSheet.flatten([big ? (wide ? null : styles.bigHitPhone) : o.sub ? styles.optionHitSub
              : styles.optionHit, disabled && styles.dim])}>
            <View style={StyleSheet.flatten([big ? (wide ? styles.bigOption : styles.bigOptionPhone) : styles.option,
              on && styles.optionOn])}>
              <Text style={StyleSheet.flatten([
                big ? (wide ? styles.bigText : styles.bigTextPhone) : styles.optionText,
                on && (big ? styles.bigTextOn : styles.optionTextOn),
                !on && o.muted && styles.optionMuted,
              ])}>{o.label}</Text>
              {o.sub ? <Text style={styles.optionSub}>{o.sub}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------- actions ----------

/** The page's main action: a square ink block with paper capitals (across the page on a phone). */
export function MainAction({ label, onPress, busy, disabled }: { label: string; onPress: () => void; busy?: boolean;
  disabled?: boolean }) {
  const styles = useStyles();
  const c = useTheme();
  const wide = useWide();
  return (
    <Pressable onPress={onPress} disabled={busy || disabled} accessibilityRole="button"
      accessibilityState={{ disabled: busy || disabled, busy }} {...noPrint}
      style={StyleSheet.flatten([styles.main, wide ? null : styles.mainPhone, (disabled && !busy) && styles.dim])}>
      {busy ? <ActivityIndicator color={c.background} /> : <Text style={styles.mainText}>{label}</Text>}
    </Pressable>
  );
}

/** A row of actions: the main block and its text links, the links centred on the block (a text link sets itself to
 * the start of its line, so each sits in a box of its own). */
export function Actions({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const styles = useStyles();
  return (
    <View style={StyleSheet.flatten([styles.actions, style])} {...noPrint}>
      {Children.map(children, (ch) => (isValidElement(ch) && ch.type !== MainAction ? <View>{ch}</View> : ch))}
    </View>
  );
}

/** A link inside a sentence: Archivo over a red underline. */
export function InlineLink({ label, onPress, url }: { label: string; onPress?: () => void; url?: string }) {
  const styles = useStyles();
  return (
    <Text style={styles.inline} accessibilityRole="link"
      onPress={onPress ?? (url ? () => (Platform.OS === 'web' ? window.open(url, '_blank', 'noopener') : Linking.openURL(url)) : undefined)}>
      {label}
    </Text>
  );
}

// ---------- the four tyres ----------

/** The four tyres laid out like the car seen from above, front at the top: ink rules between them, each corner's name
 * in an ink block. */
export function CarGrid({ cell, style }: { cell: (c: Corner) => ReactNode; style?: ViewStyle }) {
  const styles = useStyles();
  const c = useTheme();
  const rows: Corner[][] = [['FL', 'FR'], ['RL', 'RR']];
  return (
    <View style={StyleSheet.flatten([styles.car, style])}>
      <Text style={styles.carEnd}>Front</Text>
      {rows.map((row, r) => (
        <View key={row[0]} style={StyleSheet.flatten([styles.carRow, r === 1 && styles.carRowRear])}>
          {row.map((k, i) => (
            <View key={k} style={StyleSheet.flatten([styles.carCell, i === 0 ? styles.carLeft : styles.carRight])}>
              <Block label={k} color={c.rule} ink={c.background} size={13} style={styles.carTag} />
              {cell(k)}
            </View>
          ))}
        </View>
      ))}
      <Text style={styles.carEnd}>Rear</Text>
    </View>
  );
}

// ---------- words ----------

/** A reading paragraph in the secondary ink; `small` for the fine print. */
export function Note({ children, small, style }: { children: ReactNode; small?: boolean; style?: TextStyle }) {
  const styles = useStyles();
  return <Text style={StyleSheet.flatten([small ? styles.noteSmall : styles.note, style])}>{children}</Text>;
}

/** Something that went wrong, or a value under a minimum. */
export function ErrorLine({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.error}>{children}</Text>;
}

/** Something to look at before going on (a value still needed, an estimate). */
export function WarnLine({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.warn}>{children}</Text>;
}

/** A working line: the spinner in ink and what it waits for. */
export function Working({ children }: { children?: ReactNode }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.working}>
      <ActivityIndicator color={c.text} size="small" />
      {children ? <Text style={styles.noteSmall}>{children}</Text> : null}
    </View>
  );
}

/** A sub-head inside a section: a 3 px ink rule and a label in Archivo capitals, with `right` at its end. */
export function SubHead({ children, right, style }: { children: ReactNode; right?: ReactNode; style?: ViewStyle }) {
  const styles = useStyles();
  return (
    <View style={StyleSheet.flatten([styles.subHead, style])}>
      <Text style={styles.subHeadText}>{children}</Text>
      {right}
    </View>
  );
}

/** The shared table styles: a head of Archivo capitals over an ink rule, rows on faint hairlines, figures tabular. */
export const useTableStyles = themed((c) => ({
  table: { alignSelf: 'stretch' },
  head: { flexDirection: 'row', alignItems: 'flex-end', borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 5 },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: c.separator, minHeight: 34,
    paddingVertical: 5 },
  th: { ...Type.label, fontFamily: Fonts.label, fontSize: 11, letterSpacing: 1.1, color: c.textSecondary, paddingRight: 8 },
  td: { fontFamily: Fonts.mono, fontSize: 15, fontVariant: ['tabular-nums'], color: c.text, paddingRight: 8 },
  name: { fontFamily: Fonts.label, fontSize: 15, color: c.text, paddingRight: 8 },
  num: { textAlign: 'right' },
  muted: { color: c.textMuted },
  cell: { paddingHorizontal: 5, paddingTop: 2, paddingBottom: 1, alignSelf: 'flex-end' }, // a value in a flat block
  foot: { fontFamily: Type.dek.fontFamily, fontSize: 14, lineHeight: 20, color: c.textSecondary, marginTop: 8 },
}));

const useStyles = themed((c) => ({
  opening: { paddingTop: 30, paddingBottom: 4 },
  openingPhone: { paddingTop: 20, paddingBottom: 2 },
  openingMore: { marginTop: 14 },
  title: { ...Type.title, color: c.text },
  titlePhone: { ...Type.title, fontSize: 40, lineHeight: 42, color: c.text },
  dek: { ...Type.dek, fontSize: 19, lineHeight: 27, color: c.textSecondary, marginTop: 8, maxWidth: 760 },
  dekPhone: { ...Type.dek, fontSize: 17, lineHeight: 24, color: c.textSecondary, marginTop: 6 },

  // fields
  fieldFill: { flex: 1, minWidth: 0 },
  fieldLabel: { ...Type.label, fontFamily: Fonts.label, fontSize: 11, letterSpacing: 1.1, color: c.textSecondary, marginBottom: 4 },
  fieldUnit: { ...Type.label, fontFamily: face('label', 400), fontSize: 11, letterSpacing: 0.6, textTransform: 'none',
    color: c.textMuted },
  // 37 px drawn, a 45 px tap target: 8 px more room above the figures, taken back by the margin
  input: { fontFamily: Fonts.mono, fontSize: 18, fontVariant: ['tabular-nums'], color: c.text, paddingTop: 13,
    marginTop: -8, paddingBottom: 5, paddingHorizontal: 0, borderBottomWidth: 2, borderColor: c.rule, borderRadius: 0,
    minWidth: 0, backgroundColor: 'transparent', outlineWidth: 0 },
  // 29 px drawn, a 44 px tap target: 15 px more room above the figures (over the label, when there is one), taken back
  // by the margin
  inputSmall: { fontFamily: Fonts.mono, fontSize: 15, fontVariant: ['tabular-nums'], color: c.text, paddingTop: 18,
    marginTop: -15, paddingBottom: 3, paddingHorizontal: 0, borderBottomWidth: 2, borderColor: c.rule, borderRadius: 0,
    minWidth: 0, backgroundColor: 'transparent', outlineWidth: 0 },
  boxed: { fontFamily: Fonts.mono, fontSize: 15, lineHeight: 21, color: c.text, borderWidth: 1, borderColor: c.rule,
    borderRadius: 0, padding: 10, minHeight: 64, textAlignVertical: 'top', backgroundColor: 'transparent', outlineWidth: 0 },
  inputFocus: { borderColor: c.mark },
  inputWarn: { borderColor: c.warning },
  inputMarked: { borderColor: c.mark, borderBottomWidth: 3 },
  fieldNote: { fontFamily: face('label', 400), fontSize: 12, color: c.textMuted, marginTop: 3 },
  warnText: { color: c.warning },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 16, alignItems: 'flex-end' },

  // a spec sheet's line
  sheetRow: { borderBottomWidth: 1, borderColor: c.separator, paddingTop: 8, paddingBottom: 8 },
  sheetLine: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  sheetName: { flex: 1, minWidth: 0 },
  sheetLabel: { fontFamily: Fonts.label, fontSize: 15, lineHeight: 19, color: c.text },
  sheetSub: { fontFamily: face('label', 400), fontSize: 12, lineHeight: 16, color: c.textMuted, marginTop: 1 },
  sheetNote: { fontFamily: Type.dek.fontFamily, fontSize: 14, lineHeight: 19, color: c.textSecondary, marginTop: 5 },

  // stepper
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  stepKey: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: c.rule },
  stepHit: tapRoom(9, 9), // the 26 px key in a 44 px tap target
  stepKeyText: { fontFamily: Fonts.mono, fontSize: 17, lineHeight: 19, color: c.text },
  stepValue: { fontFamily: Fonts.mono, fontSize: 16, fontVariant: ['tabular-nums'], minWidth: 30, textAlign: 'center',
    color: c.text },
  stepOf: { fontFamily: face('label', 400), fontSize: 12, color: c.textMuted },

  // options
  options: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 12, alignItems: 'flex-start' },
  option: { paddingBottom: 4, borderBottomWidth: 3, borderColor: 'transparent' },
  // tap targets of 44 px round an option drawn 25 px tall (one line) or 43 px (with its sub line), and 36 px wide
  optionHit: { ...tapRoom(10, 5), maxWidth: '100%' },
  optionHitSub: { ...tapRoom(2, 5), maxWidth: '100%' },
  optionOn: { borderColor: c.mark },
  optionText: { ...Type.label, fontFamily: Fonts.label, fontSize: 14, letterSpacing: 1.3, color: c.textSecondary },
  optionTextOn: { fontFamily: Type.label.fontFamily, color: c.text },
  optionMuted: { color: c.textMuted },
  optionSub: { fontFamily: face('label', 400), fontSize: 12, color: c.textMuted, marginTop: 2, fontVariant: ['tabular-nums'] },
  optionWords: { flexShrink: 1 },
  bigOptions: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 26, rowGap: 8, alignItems: 'flex-end' },
  bigOptionsPhone: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 6, alignItems: 'flex-end' },
  bigOption: { paddingBottom: 6, borderBottomWidth: 6, borderColor: 'transparent' },
  bigOptionPhone: { paddingBottom: 5, borderBottomWidth: 5, borderColor: 'transparent' },
  bigHitPhone: tapRoom(5), // a 36 px tab in a 46 px tap target (on a computer it is 44 px already)
  bigText: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, textTransform: 'uppercase', color: c.textMuted },
  bigTextPhone: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 26, textTransform: 'uppercase', color: c.textMuted },
  bigTextOn: { color: c.text },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, maxWidth: '100%' },
  // tap targets of 44 px round a ticked option drawn 18 px tall (one line) or 36 px (with its sub line)
  checkHit: tapRoom(13),
  checkHitSub: tapRoom(4),
  checkBox: { width: 14, height: 14, borderWidth: 1.5, borderColor: c.rule, marginTop: 1 },
  checkBoxOn: { backgroundColor: c.rule },

  // actions
  main: { alignSelf: 'flex-start', alignItems: 'center', justifyContent: 'center', backgroundColor: c.rule,
    paddingVertical: 14, paddingHorizontal: 26, minHeight: 48 },
  mainPhone: { alignSelf: 'stretch', width: '100%' },
  mainText: { ...Type.link, fontSize: 15, letterSpacing: 1.8, color: c.background },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 24, rowGap: 14, marginTop: 22 },
  // a link inside a sentence: its padding makes a 44 px tap target round the word without moving a line (an inline
  // box's padding above and below takes no room; the margin takes back the room at its sides)
  inline: { fontFamily: Fonts.label, color: c.text, textDecorationLine: 'underline', textDecorationColor: c.mark,
    paddingVertical: 13, paddingHorizontal: 4, marginHorizontal: -4 },
  dim: { opacity: 0.4 },

  // the car
  car: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.rule },
  carEnd: { ...Type.label, fontFamily: Fonts.label, fontSize: 11, letterSpacing: 2, color: c.textMuted, textAlign: 'center',
    paddingVertical: 5 },
  carRow: { flexDirection: 'row' },
  carRowRear: { borderTopWidth: 1, borderColor: c.rule },
  carCell: { flex: 1, minWidth: 0, paddingTop: 12, paddingBottom: 14, gap: 8 },
  carLeft: { paddingRight: 14, borderRightWidth: 1, borderColor: c.rule },
  carRight: { paddingLeft: 14 },
  carTag: { marginBottom: 2 },

  // words
  note: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.textSecondary },
  noteSmall: { fontFamily: Fonts.body, fontSize: 14, lineHeight: 20, color: c.textSecondary },
  error: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: c.error },
  warn: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: c.warning },
  working: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  subHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12,
    borderTopWidth: 3, borderColor: c.rule, paddingTop: 7, marginBottom: 6 },
  subHeadText: { ...Type.label, fontSize: 13, letterSpacing: 1.4, color: c.text },
}));
