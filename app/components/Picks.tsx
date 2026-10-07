// The analysis pages' small controls in the programme's look, made from the shared pieces' tokens: the page's own
// headline (where there is no photo), text tabs with the picked one underlined in red, a pickable figure (a lap, a
// session), a square tick box, a flat progress bar and a ruled notice band. No boxes, no rounded corners.
import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextStyle, ViewStyle } from 'react-native';

import { useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { face, Fonts, themed, Type, useTheme } from '@/constants/Theme';
import { noPrint } from '@/lib/print';

/** A page's name where there is no photo: the Anton headline and its italic line. */
export function PageHead({ title, dek, children }: { title: string; dek?: ReactNode; children?: ReactNode }) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={styles.head}>
      <Text style={wide ? styles.title : styles.titlePhone} accessibilityRole="header">{title}</Text>
      {dek ? <Text style={wide ? styles.dek : styles.dekPhone}>{dek}</Text> : null}
      {children}
    </View>
  );
}

export type TabItem<K extends string | number | null> = {
  key: K;
  label: string;
  sub?: string; // a line under the label: a count, a lap time
  swatch?: string; // a colour key before the label (a lap's or a side's)
  dim?: boolean;
  disabled?: boolean;
};

/** A row of text tabs: Archivo capitals (or Anton for `big`), the picked one in ink over a red underline, the others
 * in the caption grey. Wraps onto more rows when it has to. */
export function Tabs<K extends string | number | null>({ items, value, onChange, big, label, style }: {
  items: TabItem<K>[];
  value: K;
  onChange: (k: K) => void;
  big?: boolean;
  label?: string; // a small label above the row
  style?: ViewStyle;
}) {
  const styles = useStyles();
  return (
    <View style={style}>
      {label ? <Text style={styles.groupLabel}>{label}</Text> : null}
      <View style={big ? styles.tabsBig : styles.tabs} accessibilityRole="tablist">
        {items.map((it) => {
          const on = it.key === value;
          return (
            // on paper only the picked tab is left, naming what is shown
            <Pressable key={String(it.key)} onPress={() => onChange(it.key)} disabled={it.disabled} {...(on ? null : noPrint)}
              accessibilityRole="tab" accessibilityState={{ selected: on, disabled: it.disabled }} hitSlop={4}
              style={StyleSheet.flatten([big ? styles.tabBig : styles.tab, on && styles.tabOn,
                (it.dim || it.disabled) && !on && styles.dim])}>
              <View style={styles.tabRow}>
                {it.swatch ? <View style={StyleSheet.flatten([styles.tabKey, { backgroundColor: it.swatch }])} /> : null}
                <Text style={StyleSheet.flatten([big ? styles.tabTextBig : styles.tabText, on && styles.tabTextOn])}>
                  {it.label}
                </Text>
              </View>
              {it.sub ? <Text style={styles.tabSub}>{it.sub}</Text> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** One thing to pick among many (a lap, a session): its name over its figure, the picked one underlined in red.
 * `fill` paints the figure as a flat block (the event's fastest lap in purple), with `ink` on it. */
export function Choice({ label, detail, on, onPress, fill, ink, dim, disabled, accessibilityLabel }: {
  label: string;
  detail?: string;
  on: boolean;
  onPress: () => void;
  fill?: string;
  ink?: string;
  dim?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const styles = useStyles();
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: on, disabled }} hitSlop={2} {...(on ? null : noPrint)}
      style={StyleSheet.flatten([styles.pick, on && styles.tabOn, (dim || disabled) && !on && styles.dim])}>
      <Text style={StyleSheet.flatten([styles.pickLabel, on && styles.tabTextOn])}>{label}</Text>
      {detail ? (
        <View style={StyleSheet.flatten([styles.pickDetailBox, fill ? { backgroundColor: fill } : null])}>
          <Text style={StyleSheet.flatten([styles.pickDetail, fill && ink ? { color: ink } : null])}>{detail}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** A square tick box: an ink outline, filled in ink with a paper tick when on (or in `color`, a side's). */
export function TickBox({ on, color, size = 20 }: { on: boolean; color?: string; size?: number }) {
  const styles = useStyles();
  const c = useTheme();
  const fill = color ?? c.tint;
  return (
    <View style={StyleSheet.flatten([styles.box, { width: size, height: size },
      on && { backgroundColor: fill, borderColor: fill }])}>
      {on ? <Text style={styles.tick}>✓</Text> : null}
    </View>
  );
}

/** A labelled tick box that switches something on or off. */
export function Toggle({ on, onChange, label, detail }: { on: boolean; onChange: (v: boolean) => void; label: string;
  detail?: string }) {
  const styles = useStyles();
  return (
    <Pressable onPress={() => onChange(!on)} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
      style={styles.toggle} hitSlop={4}>
      <TickBox on={on} />
      <View style={styles.flex}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {detail ? <Text style={styles.toggleDetail}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

/** A flat progress bar: ink on the faint rule, square. */
export function Meter({ share, color, height = 6 }: { share: number; color?: string; height?: number }) {
  const c = useTheme();
  return (
    <View style={{ height, backgroundColor: c.fill }}>
      <View style={{ height, width: `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`,
        backgroundColor: color ?? c.tint }} />
    </View>
  );
}

/** A notice across the page between two ink rules: work in progress, a failure and what to do about it. */
export function Notice({ busy, children, style }: { busy?: boolean; children: ReactNode; style?: ViewStyle }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={StyleSheet.flatten([styles.notice, style])}>
      {busy ? <ActivityIndicator color={c.text} /> : null}
      <View style={styles.noticeBody}>{children}</View>
    </View>
  );
}

/** The solid ink block of a page's main action: paper capitals on ink, square. */
export function MainAction({ label, onPress, disabled, busy }: { label: string; onPress: () => void;
  disabled?: boolean; busy?: boolean }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }} {...noPrint}
      style={StyleSheet.flatten([styles.action, (disabled || busy) && styles.actionOff])}>
      {busy ? <ActivityIndicator color={c.onTint} /> : <Text style={styles.actionText}>{label}</Text>}
    </Pressable>
  );
}

/** A row of big figures split by ink rules, an ink rule over them: one row on a wide screen, two to a row on a
 * phone. */
export function FigRow({ children, style, phoneCols = 2 }: { children: ReactNode[]; style?: ViewStyle;
  phoneCols?: number }) {
  const styles = useStyles();
  const wide = useWide();
  const items = children.filter(Boolean);
  const n = phoneCols;
  return (
    <View style={StyleSheet.flatten([styles.figs, style])}>
      {items.map((child, i) => (
        <View key={i} style={StyleSheet.flatten([wide ? styles.figCell : styles.figCellPhone,
          !wide && { width: `${100 / n}%` as const }, (wide ? i > 0 : i % n > 0) && styles.figRule,
          !wide && i >= n && styles.figTop, (wide ? i === 0 : i % n === 0) && styles.figFirst])}>
          {child}
        </View>
      ))}
    </View>
  );
}

/** Type for the analysis pages: reading text, its small grey notes, the lead sentence and labels in columns. */
export const useText = themed((c) => ({
  body: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text } as TextStyle,
  lead: { fontFamily: face('body', 600), fontSize: 19, lineHeight: 27, color: c.text } as TextStyle,
  note: { fontFamily: Fonts.body, fontSize: 14, lineHeight: 20, color: c.textSecondary } as TextStyle,
  small: { fontFamily: Fonts.body, fontSize: 13, lineHeight: 18, color: c.textMuted } as TextStyle,
  italic: { fontFamily: face('body', 400, true), fontSize: 15, lineHeight: 21, color: c.textSecondary } as TextStyle,
  strong: { fontFamily: face('body', 700), color: c.text } as TextStyle,
  label: { ...Type.label, color: c.text } as TextStyle,
  labelMuted: { ...Type.label, color: c.textMuted } as TextStyle,
  num: { ...Type.number, fontSize: 14, color: c.text } as TextStyle,
  error: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: c.error } as TextStyle,
  // a thin ink rule with a label on it: the head of a block inside a section
  sub: { ...Type.label, color: c.text, borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 6 } as TextStyle,
}));

const useStyles = themed((c) => ({
  head: { paddingTop: 26, gap: 8 },
  title: { ...Type.title, color: c.text },
  titlePhone: { ...Type.title, fontSize: 36, lineHeight: 38, color: c.text },
  dek: { ...Type.dek, color: c.textSecondary, maxWidth: 720 },
  dekPhone: { ...Type.dek, fontSize: 16, lineHeight: 22, color: c.textSecondary },
  groupLabel: { ...Type.label, fontSize: 11, color: c.textMuted, marginBottom: 6 },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 10, alignItems: 'flex-end' },
  tabsBig: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 10, alignItems: 'flex-end' },
  tab: { paddingBottom: 4, borderBottomWidth: 3, borderColor: 'transparent' },
  tabBig: { paddingBottom: 4, borderBottomWidth: 4, borderColor: 'transparent' },
  tabOn: { borderColor: c.mark },
  tabRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  tabKey: { width: 14, height: 4 },
  tabText: { ...Type.label, fontSize: 13, letterSpacing: 1.3, color: c.textMuted },
  tabTextBig: { fontFamily: Fonts.display, fontSize: 22, lineHeight: 26, textTransform: 'uppercase', color: c.textMuted },
  tabTextOn: { color: c.text },
  tabSub: { ...Type.number, fontSize: 12, color: c.textMuted, marginTop: 2 },
  dim: { opacity: 0.45 },
  pick: { paddingBottom: 3, borderBottomWidth: 3, borderColor: 'transparent', minWidth: 58, gap: 2 },
  pickLabel: { fontFamily: Fonts.display, fontSize: 18, lineHeight: 21, color: c.textMuted },
  pickDetailBox: { alignSelf: 'flex-start', paddingHorizontal: 0 },
  pickDetail: { ...Type.number, fontSize: 13, color: c.text, paddingHorizontal: 2 },
  box: { borderWidth: 2, borderColor: c.borderStrong, alignItems: 'center', justifyContent: 'center' },
  tick: { fontFamily: face('label', 700), fontSize: 13, lineHeight: 15, color: c.onTint },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  toggleLabel: { ...Type.label, fontSize: 13, color: c.text },
  toggleDetail: { fontFamily: Fonts.body, fontSize: 14, lineHeight: 20, color: c.textSecondary },
  flex: { flex: 1, minWidth: 0 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderTopWidth: 1, borderBottomWidth: 1,
    borderColor: c.rule, paddingVertical: 12 },
  noticeBody: { flex: 1, minWidth: 0, gap: 8 },
  action: { alignSelf: 'flex-start', backgroundColor: c.tint, paddingHorizontal: 18, paddingVertical: 12,
    minHeight: 46, justifyContent: 'center', maxWidth: '100%' },
  actionOff: { opacity: 0.45 },
  actionText: { ...Type.link, fontSize: 15, color: c.onTint },
  figs: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, borderColor: c.rule },
  figCell: { flex: 1, minWidth: 0, paddingTop: 12, paddingHorizontal: 18 },
  figCellPhone: { width: '50%', paddingTop: 10, paddingBottom: 12, paddingHorizontal: 10 },
  figFirst: { paddingLeft: 0 },
  figRule: { borderLeftWidth: 1, borderColor: c.rule },
  figTop: { borderTopWidth: 1, borderColor: c.rule },
}));
