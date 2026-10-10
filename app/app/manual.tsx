// The manual (Gabriele, 2026-10-10: "Can you add a 'user manual' with all functions explained and where to find
// them? Add it in the app"): every function in plain words and the taps that reach it, grouped by where it sits
// (lib/manual.ts). Opened from the masthead's Manual on every page. Type to find a function; the parts' names jump to
// them; a function with a page of its own opens it.
import { Stack } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { ScrollView } from 'react-native';

import { Field, Input, Note } from '@/components/Controls';
import { PageHead } from '@/components/Picks';
import { Colophon, Page, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { findInManual, MANUAL, ManualItem } from '@/lib/manual';
import { face, Fonts, themed, Type } from '@/constants/Theme';

export default function ManualScreen() {
  const styles = useStyles();
  const [query, setQuery] = useState('');
  const parts = useMemo(() => findInManual(MANUAL, query), [query]);
  const found = parts.reduce((n, p) => n + p.items.length, 0);
  const total = MANUAL.reduce((n, p) => n + p.items.length, 0);
  const scroll = useRef<ScrollView>(null);
  const tops = useRef(new Map<string, number>());
  const jump = (key: string) => scroll.current?.scrollTo({ y: Math.max(0, (tops.current.get(key) ?? 0) - 12), animated: true });

  return (
    <Page scrollRef={scroll}>
      <Stack.Screen options={{ title: 'Manual' }} />
      <PageHead title="Manual"
        dek="Every function in plain words and the taps that reach it, part by part as the app is laid out. Type to find one, or jump to a part." />
      <Field label="Find in the manual" style={styles.find}>
        <Input value={query} onChangeText={setQuery} placeholder="e.g. delete, tyres, debrief, TC"
          accessibilityLabel="Find in the manual" autoCorrect={false} autoCapitalize="none" box
          style={styles.findInput} />
      </Field>
      {query.trim() !== '' && (
        <Text style={styles.count} accessibilityLiveRegion="polite">
          {found === 0 ? 'Nothing found: try another word.' : `${found} of ${total} functions`}
        </Text>
      )}
      {query.trim() === '' && (
        <View style={styles.jumps}>
          {MANUAL.map((p) => <TextLink key={p.key} label={p.title} small onPress={() => jump(p.key)} />)}
        </View>
      )}
      {parts.map((p) => (
        <Section key={p.key} no={MANUAL.findIndex((m) => m.key === p.key) + 1} title={p.title} dek={p.dek}
          onLayout={(e) => tops.current.set(p.key, e.nativeEvent.layout.y)}>
          {p.href && <View style={styles.open}><TextLink label={`Open ${p.title}`} href={p.href} arrow small /></View>}
          {p.items.map((item) => <Item key={item.name} item={item} />)}
        </Section>
      ))}
      {parts.length === 0 && <Note style={styles.none}>Nothing in the manual has those words.</Note>}
      <Colophon left="The Engineer · Manual" right={`${total} functions`} />
    </Page>
  );
}

/** One function: its name, where it is (the taps, in order), what it does, and its page when it has one. */
function Item({ item }: { item: ManualItem }) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={wide ? styles.item : styles.itemPhone}>
      <Text style={styles.name} accessibilityRole="header">{item.name}</Text>
      <Text style={styles.where}>
        <Text style={styles.whereLabel}>Where: </Text>
        {item.where.join('  ›  ')}
      </Text>
      <Text style={styles.what}>{item.what}</Text>
      {item.href && <View style={styles.itemOpen}><TextLink label="Open it" href={item.href} arrow small /></View>}
    </View>
  );
}

const useStyles = themed((c) => ({
  find: { maxWidth: 520, marginTop: 22 },
  findInput: { minHeight: 48, fontSize: 17 },
  count: { ...Type.label, fontSize: 14, color: c.textSecondary, marginTop: 10 },
  jumps: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, rowGap: 6, marginTop: 18, maxWidth: 900 },
  open: { flexDirection: 'row', marginBottom: 6 },
  none: { marginTop: 24 },
  item: { borderTopWidth: 1, borderColor: c.separator, paddingVertical: 14, maxWidth: 760 },
  itemPhone: { borderTopWidth: 1, borderColor: c.separator, paddingVertical: 12 },
  name: { fontFamily: face('label', 700), fontSize: 18, lineHeight: 24, letterSpacing: 0.3, color: c.text },
  where: { fontFamily: face('label', 400), fontSize: 16, lineHeight: 22, color: c.textSecondary, marginTop: 4 },
  whereLabel: { fontFamily: face('label', 700), color: c.textSecondary },
  what: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 25, color: c.text, marginTop: 6 },
  itemOpen: { flexDirection: 'row', marginTop: 2 },
}));
