// The programme's form controls, for the pages that make and change things (events, seasons, the garage, tagging,
// the calendar, sign-in): a field with its Archivo label above, a square input on a single ink rule, a choice among
// words (the picked one underlined in red, as the masthead's), a square tick box, the main action as a solid ink block,
// and the line said after an action. Square edges, ink rules, colours from constants/Colors.ts. The page pieces
// (sections, figures, text links) are in components/Programme.tsx.
import { Children, forwardRef, ReactNode, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, TextInputProps, TextStyle, ViewStyle } from 'react-native';

import { useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { Fonts, TAP, tapRoom, themed, Type, useTheme } from '@/constants/Theme';
import { noPrint } from '@/lib/print';
import { a11yState } from '@/lib/a11yState';

/** The head of a page without a photo (it keeps the bar above it): a grey kicker, the page's name in Anton and its
 * italic line. */
export function PageTitle({ kicker, title, dek }: { kicker?: string; title: string; dek?: string }) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={wide ? styles.head : styles.headPhone}>
      {kicker ? <Text style={styles.kicker}>{kicker}</Text> : null}
      <Text style={wide ? styles.title : styles.titlePhone} accessibilityRole="header">{title}</Text>
      {dek ? <Text style={wide ? styles.dek : styles.dekPhone}>{dek}</Text> : null}
    </View>
  );
}

/** A form field: its label in Archivo capitals above the control, and an italic note beside the label (where a value
 * came from). `focus`: a red rule down its left, the field a checklist item points at. */
export function Field({ label, note, focus, children, style }: {
  label: string;
  note?: string | null;
  focus?: boolean;
  children: ReactNode;
  style?: ViewStyle;
}) {
  const styles = useStyles();
  return (
    <View style={StyleSheet.flatten([styles.field, focus && styles.fieldFocus, style])}>
      <View style={styles.fieldHead}>
        <Text style={StyleSheet.flatten([styles.label, focus && styles.labelFocus])}>{label}</Text>
        {note ? <Text style={styles.from}>{note}</Text> : null}
      </View>
      {children}
    </View>
  );
}

/** A text input: square, on a single ink rule that turns red while typing in it. `large`: an event's name. */
export const Input = forwardRef<TextInput, TextInputProps & { large?: boolean; box?: boolean }>(
  function Input({ large, box, style, onFocus, onBlur, ...rest }, ref) {
    const styles = useStyles();
    const c = useTheme();
    const [focused, setFocused] = useState(false);
    return (
      <TextInput ref={ref} placeholderTextColor={c.textMuted} {...rest}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        style={StyleSheet.flatten([styles.input, box && styles.inputBox, large && styles.inputLarge,
          focused && styles.inputFocus, { color: c.text }, style as TextStyle])} />
    );
  });

/** One of several words to pick from (a tyre, a team, a driver, a year): Archivo capitals, the picked one in ink over a
 * red underline, the others in grey. `add`: the "+ New ..." word that opens a field, underlined in ink. */
export function Choice({ label, sub, on, onPress, add, disabled }: {
  label: string;
  sub?: string | null;
  on: boolean;
  onPress: () => void;
  add?: boolean;
  disabled?: boolean;
}) {
  const styles = useStyles();
  const role = add ? 'button' : 'radio';
  return (
    // on paper only the picked word is left; the pressable box is a full tap target around the word
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole={role}
      {...a11yState(add ? { disabled } : { selected: on, checked: on, disabled }, role)}
      {...(on && !add ? null : noPrint)}
      style={StyleSheet.flatten([styles.choiceHit, disabled && styles.dim])}>
      <View style={StyleSheet.flatten([styles.choice, on && styles.choiceOn, add && styles.choiceAdd])}>
        <Text style={StyleSheet.flatten([styles.choiceText, (on || add) && styles.choiceTextOn])} numberOfLines={1}>
          {label}
        </Text>
        {sub ? <Text style={styles.choiceSub} numberOfLines={1}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}

/** A row of choices that wraps. */
export function Choices({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const styles = useStyles();
  return <View style={StyleSheet.flatten([styles.choices, style])}>{children}</View>;
}

/** A square tick box: an ink outline, filled ink with a paper tick when ticked. */
export function Tick({ on, onPress, disabled, label, size = 22 }: {
  on: boolean;
  onPress?: () => void;
  disabled?: boolean;
  label?: string; // what it ticks, for screen readers
  size?: number;
}) {
  const styles = useStyles();
  const box = (
    <View style={StyleSheet.flatten([styles.tick, { width: size, height: size }, on && styles.tickOn,
      disabled && !on && styles.dim])}>
      {on ? <Text style={StyleSheet.flatten([styles.tickMark, { fontSize: size * 0.68, lineHeight: size * 0.8 }])}>✓</Text>
        : null}
    </View>
  );
  if (!onPress) return box;
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="checkbox"
      {...a11yState({ checked: on, disabled })} accessibilityLabel={label}
      style={tapRoom(Math.max(0, (TAP - size) / 2), Math.max(0, (TAP - size) / 2))}>
      {box}
    </Pressable>
  );
}

/** The main action of a form or a page: a solid ink block with paper capitals (`danger`: a red block, for a delete),
 * and `sub`, a small line under them (why this answer). `busy`: a spinner in its place. */
export function MainButton({ label, sub, onPress, busy, disabled, danger, style }: {
  label: string;
  sub?: string | null;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  danger?: boolean;
  style?: ViewStyle;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} accessibilityRole="button" {...noPrint}
      accessibilityLabel={sub ? `${label}: ${sub}` : label} {...a11yState({ disabled: disabled || busy, busy })}
      style={StyleSheet.flatten([styles.main, danger && styles.mainDanger, (disabled && !busy) && styles.dim, style])}>
      {busy ? <ActivityIndicator color={c.background} /> : (
        <>
          <Text style={styles.mainText}>{label}</Text>
          {sub ? <Text style={styles.mainSub}>{sub}</Text> : null}
        </>
      )}
    </Pressable>
  );
}

/** The buttons under a form: the main action, then the quieter ones as text links, all on the row's middle line
 * (each in a cell as tall as the row: a text link keeps to the top of whatever holds it). */
export function FormActions({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const styles = useStyles();
  return (
    <View style={StyleSheet.flatten([styles.actions, style])} {...noPrint}>
      {Children.toArray(children).map((child, i) => <View key={i} style={styles.actionCell}>{child}</View>)}
    </View>
  );
}

/** What an action did, in a line with an ink rule down its left (tap it to put it away); `error` in red. */
export function Said({ text, error, warn, onPress }: { text: string; error?: boolean; warn?: boolean; onPress?: () => void }) {
  const styles = useStyles();
  const line = (
    <View style={StyleSheet.flatten([styles.said, error && styles.saidError])}>
      <Text style={StyleSheet.flatten([styles.saidText, error && styles.errorText, warn && styles.warnText])}>{text}</Text>
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityHint="Hides this line" style={styles.saidHit}>
      {line}
    </Pressable>
  ) : line;
}

/** A short line of help or what is going on: Newsreader, grey. */
export function Note({ children, style }: { children: ReactNode; style?: TextStyle }) {
  const styles = useStyles();
  return <Text style={StyleSheet.flatten([styles.note, style])}>{children}</Text>;
}

/** An error in red. */
export function ErrorLine({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.error}>{children}</Text>;
}

/** A flat bar of how far something has got, 0 to 1 (or null: not known yet): an ink outline on the darker sheet, filled
 * in ink (red when it failed), square ends. */
export function ProgressBar({ share, failed, label }: { share: number | null; failed?: boolean; label: string }) {
  const styles = useStyles();
  const s = share == null ? 0 : Math.max(0, Math.min(1, share));
  return (
    <View style={styles.bar} accessibilityRole="progressbar" accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(s * 100) }}>
      <View style={StyleSheet.flatten([styles.barFill, failed && styles.barFailed, { width: `${s * 100}%` }])} />
    </View>
  );
}

const useStyles = themed((c) => ({
  head: { paddingTop: 26 },
  headPhone: { paddingTop: 18 },
  kicker: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, letterSpacing: 1.6, color: c.textMuted, marginBottom: 6 },
  title: { ...Type.title, color: c.text },
  titlePhone: { ...Type.title, fontSize: 36, lineHeight: 38, color: c.text },
  dek: { ...Type.dek, color: c.textSecondary, marginTop: 8, maxWidth: 680 },
  dekPhone: { ...Type.dek, fontSize: 16, lineHeight: 22, color: c.textSecondary, marginTop: 6 },

  field: { gap: 6, borderLeftWidth: 0, borderColor: c.mark },
  fieldFocus: { borderLeftWidth: 3, paddingLeft: 10 },
  fieldHead: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 10, rowGap: 2 },
  label: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, letterSpacing: 1.4, color: c.text },
  labelFocus: { color: c.error },
  from: { fontFamily: Type.dek.fontFamily, fontSize: 14, lineHeight: 19, color: c.textSecondary },

  // 44 px tall: a tap target
  input: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 22, paddingHorizontal: 0, paddingTop: 10, paddingBottom: 10,
    borderBottomWidth: 2, borderColor: c.rule, backgroundColor: 'transparent', minWidth: 0, outlineWidth: 0 },
  inputBox: { borderWidth: 1, borderBottomWidth: 2, paddingHorizontal: 8 },
  inputLarge: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 36, textTransform: 'uppercase' },
  inputFocus: { borderColor: c.mark },

  choices: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', columnGap: 18, rowGap: 12 },
  // the word is about 22 px tall with its underline: 11 px of room above and below make a 44 px tap target
  choiceHit: { maxWidth: '100%', minWidth: TAP, ...tapRoom(11) },
  choice: { alignSelf: 'flex-start', maxWidth: '100%', paddingBottom: 2, borderBottomWidth: 3, borderColor: 'transparent' },
  choiceOn: { borderColor: c.mark },
  choiceAdd: { borderBottomWidth: 2, borderColor: c.rule },
  choiceText: { ...Type.label, fontFamily: Fonts.label, fontSize: 14, letterSpacing: 1.2, color: c.textMuted },
  choiceTextOn: { color: c.text },
  choiceSub: { fontFamily: Fonts.label, fontSize: 13, letterSpacing: 0.4, color: c.textSecondary, marginTop: 1 },

  tick: { borderWidth: 2, borderColor: c.rule, alignItems: 'center', justifyContent: 'center' },
  tickOn: { backgroundColor: c.rule },
  tickMark: { fontFamily: Fonts.label, color: c.background, textAlign: 'center' },

  main: { alignSelf: 'flex-start', maxWidth: '100%', minWidth: 120, minHeight: TAP, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.rule, paddingHorizontal: 18, paddingVertical: 10 },
  mainDanger: { backgroundColor: c.error },
  mainText: { ...Type.link, color: c.background, textAlign: 'center' },
  mainSub: { fontFamily: Fonts.label, fontSize: 13, letterSpacing: 0.3, lineHeight: 17, color: c.background,
    textAlign: 'center', marginTop: 2, opacity: 0.85 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch', columnGap: 22, rowGap: 12, marginTop: 4 },
  actionCell: { justifyContent: 'center', maxWidth: '100%' },

  said: { borderLeftWidth: 3, borderColor: c.rule, paddingLeft: 10, paddingVertical: 2 },
  saidHit: tapRoom(9),
  saidError: { borderColor: c.error },
  saidText: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.text },
  errorText: { color: c.error },
  warnText: { color: c.warning },
  note: { fontFamily: Type.dek.fontFamily, fontSize: 16, lineHeight: 22, color: c.textSecondary },
  error: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.error },
  dim: { opacity: 0.45 },

  bar: { height: 12, borderWidth: 1, borderColor: c.rule, backgroundColor: c.band, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: c.rule },
  barFailed: { backgroundColor: c.error },
}));
