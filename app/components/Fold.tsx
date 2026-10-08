// Headings that fold what is under them (tap to fold or open), as the Seasons page folds its seasons: the big one with
// the thick rule and its number in an ink block (a season, a year of events), and the smaller one under it with the
// day-head rules (a championship in a year). Square edges and rules only; the ▸ / ▾ mark says folded or open.
import { ReactNode } from 'react';
import { Pressable } from 'react-native';

import { useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { Fonts, themed, Type } from '@/constants/Theme';
import { a11yState } from '@/lib/a11yState';

/** The big fold: the thick rule, the number in an ink block, the title, its facts in capitals (and anything after
 * them, like a coloured block), and the mark. `what` names what folds, for screen readers ("the season"). */
export function FoldHead({ no, title, facts, extra, open, onToggle, what, label }: {
  no: number;
  title: string;
  facts: string;
  extra?: ReactNode;
  open: boolean;
  onToggle: () => void;
  what: string;
  label?: string; // what a screen reader says, when more than the title and facts
}) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <Pressable onPress={onToggle} accessibilityRole="button" {...a11yState({ expanded: open })}
      accessibilityLabel={label ?? `${title}, ${facts}`} accessibilityHint={open ? `Folds ${what}` : `Opens ${what}`}>
      <View style={styles.rule} />
      <View style={wide ? styles.head : styles.headPhone}>
        <View style={styles.no}><Text style={styles.noText}>{String(no).padStart(2, '0')}</Text></View>
        <View style={styles.words}>
          <Text style={wide ? styles.title : styles.titlePhone}>{title}</Text>
          <View style={styles.facts}>
            <Text style={styles.fact}>{facts}</Text>
            {extra}
          </View>
        </View>
        <Text style={wide ? styles.mark : styles.markPhone}>{open ? '▾' : '▸'}</Text>
      </View>
    </Pressable>
  );
}

/** The smaller fold under a big one: the title between a heavy rule and a thin one, its facts beside it, the mark. */
export function SubFoldHead({ title, facts, open, onToggle, what }: {
  title: string;
  facts: string;
  open: boolean;
  onToggle: () => void;
  what: string;
}) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <Pressable onPress={onToggle} accessibilityRole="button" {...a11yState({ expanded: open })}
      accessibilityLabel={`${title}, ${facts}`} accessibilityHint={open ? `Folds ${what}` : `Opens ${what}`}
      style={wide ? styles.sub : styles.subPhone}>
      <View style={wide ? styles.subWords : styles.subWordsPhone}>
        <Text style={wide ? styles.subTitle : styles.subTitlePhone}>{title}</Text>
        <Text style={styles.fact}>{facts}</Text>
      </View>
      <Text style={styles.subMark}>{open ? '▾' : '▸'}</Text>
    </Pressable>
  );
}

const useStyles = themed((c) => ({
  rule: { height: 6, backgroundColor: c.rule },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 20, paddingTop: 10 },
  headPhone: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingTop: 10 },
  no: { backgroundColor: c.rule, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 5 },
  noText: { fontFamily: Fonts.display, fontSize: 22, lineHeight: 24, letterSpacing: 0.9, color: c.background },
  words: { flex: 1, minWidth: 0, gap: 6 },
  title: { fontFamily: Fonts.display, fontSize: 44, lineHeight: 46, textTransform: 'uppercase', color: c.text },
  titlePhone: { fontFamily: Fonts.display, fontSize: 27, lineHeight: 30, textTransform: 'uppercase', color: c.text },
  facts: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 6 },
  fact: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, letterSpacing: 1.2, color: c.textSecondary,
    fontVariant: ['tabular-nums'] },
  mark: { fontFamily: Fonts.label, fontSize: 26, lineHeight: 46, color: c.text, width: 26, textAlign: 'right' },
  markPhone: { fontFamily: Fonts.label, fontSize: 22, lineHeight: 30, color: c.text, width: 20, textAlign: 'right' },

  sub: { flexDirection: 'row', alignItems: 'center', gap: 16, borderTopWidth: 3, borderBottomWidth: 1,
    borderColor: c.rule, paddingTop: 8, paddingBottom: 7 },
  subPhone: { flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: 3, borderBottomWidth: 1,
    borderColor: c.rule, paddingTop: 8, paddingBottom: 7 },
  subWords: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 16,
    rowGap: 2 },
  subWordsPhone: { flex: 1, minWidth: 0, gap: 3 },
  subTitle: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 31, textTransform: 'uppercase', color: c.text },
  subTitlePhone: { fontFamily: Fonts.display, fontSize: 22, lineHeight: 25, textTransform: 'uppercase', color: c.text },
  subMark: { fontFamily: Fonts.label, fontSize: 20, lineHeight: 24, color: c.text, width: 20, textAlign: 'right' },
}));
