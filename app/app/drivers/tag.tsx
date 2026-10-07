import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { ErrorLine, MainButton, Note, PageTitle, Said, Tick } from '@/components/Controls';
import { Choice, DriverChoice, toPick } from '@/components/DriverPicker';
import { Colophon, Page, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { todayIso } from '@/lib/calendar';
import { Driver, driversApi } from '@/lib/drivers';
import { dateRange, dayLabel, dayTitle, Folder } from '@/lib/events';
import { firstOpen, loadBlocks, Outing, outingsOf, withoutDriver } from '@/lib/tagging';
import { Fonts, themed, Type } from '@/constants/Theme';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Tag outings with their driver: tick outings (or a whole event or day), pick the driver, set it for all of them.
// One block per event as the Sessions tab shows them, newest first; the event on now (else the newest) opens.
// The programme's way: section 01 the driver and the button that sets it, section 02 the outings as ruled rows with
// square tick boxes.
export default function TagDriversScreen() {
  const styles = useStyles();
  const wide = useWide();
  const [blocks, setBlocks] = useState<Folder[] | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [choice, setChoice] = useState<Choice | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { event } = useLocalSearchParams<{ event?: string }>(); // opened for one event (asked who drove it)

  const load = useCallback(async () => {
    try {
      const [b, d] = await Promise.all([loadBlocks(), driversApi.list()]);
      setBlocks(b);
      setDrivers(d);
      setOpen((o) => o ?? new Set([event ?? firstOpen(b, todayIso())].filter((k): k is string => k != null)));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const driverName = (id: number | null | undefined) => drivers.find((d) => d.id === id)?.name;
  const toggle = (ids: number[], on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });
  const flip = (key: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const target =
    choice === undefined ? null : choice === null ? 'no driver' : 'id' in choice ? driverName(choice.id) : choice.name.trim();
  const ready = picked.size > 0 && choice !== undefined && target !== '';

  const apply = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await driversApi.assign(toPick(choice!), [...picked]);
      setDone(`${plural(r.session_ids.length, 'outing')} now ${r.driver ? `driven by ${r.driver.name}` : 'without a driver'}.`);
      setPicked(new Set());
      if (r.driver) setChoice({ id: r.driver.id });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (choice == null || !('id' in choice)) return;
    if (!confirmRemove) return setConfirmRemove(true);
    setConfirmRemove(false);
    try {
      await driversApi.remove(choice.id);
      setChoice(undefined);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // "Tick all 6", or "Untick all" once they all are
  const tickAll = (outings: Outing[]) => {
    const ids = outings.map((o) => o.id);
    const all = ids.every((id) => picked.has(id));
    return <TextLink label={all ? 'Untick all' : `Tick all ${ids.length}`} onPress={() => toggle(ids, !all)} small />;
  };

  const row = (o: Outing) => {
    const on = picked.has(o.id);
    const who = o.driver ?? driverName(o.driver_id);
    return (
      <Pressable key={o.id} onPress={() => toggle([o.id], !on)} style={styles.row} accessibilityRole="checkbox"
        accessibilityState={{ checked: on }} accessibilityLabel={`${o.name}, ${who ?? 'no driver'}`}>
        <Tick on={on} />
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={2}>{o.name}</Text>
          <Text style={StyleSheet.flatten([styles.rowSub, !who && styles.noDriver])}>
            {[o.time, who ?? 'no driver'].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <Text style={styles.time}>{formatLap(o.best_lap_s)}</Text>
      </Pressable>
    );
  };

  const block = (b: Folder) => {
    const outings = outingsOf(b);
    const loose = b.id == null;
    const isOpen = open?.has(b.key) ?? false;
    const missing = withoutDriver(outings);
    const ticked = outings.filter((o) => picked.has(o.id)).length;
    const summary = [
      loose ? null : dateRange(b.start, b.end),
      plural(outings.length, 'outing'),
      missing ? `${missing} without a driver` : 'all with a driver',
      ticked ? `${ticked} ticked` : null,
    ].filter(Boolean).join(' · ');
    return (
      <View key={b.key} style={styles.block}>
        <View style={styles.head}>
          <Pressable onPress={() => flip(b.key)} style={styles.headText} accessibilityRole="button"
            aria-expanded={isOpen} accessibilityLabel={`${b.name}, ${summary}`}>
            <Text style={styles.chevron}>{isOpen ? '−' : '+'}</Text>
            <View style={styles.headWords}>
              <Text style={wide ? styles.blockTitle : styles.blockTitlePhone} numberOfLines={2}>{b.name}</Text>
              <Text style={StyleSheet.flatten([styles.summary, missing > 0 && styles.summaryMissing])}>{summary}</Text>
            </View>
          </Pressable>
          {tickAll(outings)}
        </View>
        {isOpen && b.days.map((d, i) => {
          const title = loose ? (d.date ? dayLabel(d.date, { long: true, year: true }) : 'Date not known') : dayTitle(b.days, i);
          return (
            <View key={d.date ?? 'undated'} style={styles.day}>
              <View style={styles.dayHead}>
                <Text style={styles.dayTitle} numberOfLines={1}>{title}</Text>
                {tickAll(d.sessions)}
              </View>
              {(d.sessions as Outing[]).map(row)}
            </View>
          );
        })}
      </View>
    );
  };

  const named = choice != null && 'id' in choice ? driverName(choice.id) : null;
  return (
    <Page>
      <Stack.Screen options={{ title: 'Tag drivers' }} />
      <PageTitle kicker="Drivers" title="Tag drivers"
        dek="Tick the outings one driver drove (or a whole event or day), pick the driver, and set it for all of them at once." />

      <Section no={1} title="Driver" dek="Who drove the outings you tick.">
        <View style={styles.driver}>
          <DriverChoice drivers={drivers} value={choice} onChange={(c) => {
            setChoice(c);
            setConfirmRemove(false);
          }} />
          {named ? (
            <View style={styles.removeRow}>
              <TextLink label={confirmRemove ? `Yes, remove ${named}` : `Remove ${named}`} onPress={remove} small />
              {confirmRemove ? <Note>Their outings stay, without a driver.</Note> : null}
              {confirmRemove ? <TextLink label="Keep" onPress={() => setConfirmRemove(false)} small /> : null}
            </View>
          ) : null}
          <View style={styles.apply}>
            <MainButton onPress={apply} busy={busy} disabled={!ready}
              label={picked.size === 0
                ? 'Tick the outings below'
                : !ready
                  ? `Pick the driver of ${plural(picked.size, 'outing')}`
                  : `Set ${target} on ${plural(picked.size, 'outing')}`} />
          </View>
          {done && <Said text={done} onPress={() => setDone(null)} />}
          {error && <ErrorLine>{error}</ErrorLine>}
        </View>
      </Section>

      <Section no={2} title="Outings" dek="By event, newest first. Tap an event to open it.">
        {!blocks && !error && <ActivityIndicator style={styles.spinner} />}
        {blocks?.map(block)}
        {blocks?.length === 0 && <Note>No outings yet.</Note>}
      </Section>

      <Colophon left="Tag drivers" links={[{ label: 'Garage', href: '/garage' }, { label: 'Compare drivers', href: '/drivers/compare' }]} />
    </Page>
  );
}

const useStyles = themed((c) => ({
  driver: { gap: 18 },
  removeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 16, rowGap: 6 },
  apply: { paddingTop: 4 },
  spinner: { alignSelf: 'flex-start', marginVertical: 12 },

  block: { borderTopWidth: 2, borderColor: c.rule, paddingTop: 12, paddingBottom: 14 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  headText: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  chevron: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 28, width: 16, color: c.text },
  headWords: { flex: 1, gap: 4 },
  blockTitle: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 30, textTransform: 'uppercase', color: c.text },
  blockTitlePhone: { fontFamily: Fonts.display, fontSize: 21, lineHeight: 25, textTransform: 'uppercase', color: c.text },
  summary: { fontFamily: Fonts.label, fontSize: 13, letterSpacing: 0.4, lineHeight: 18, color: c.textSecondary,
    fontVariant: ['tabular-nums'] },
  summaryMissing: { color: c.text },

  day: { marginTop: 12 },
  dayHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, paddingBottom: 6,
    borderBottomWidth: 1, borderColor: c.rule },
  dayTitle: { ...Type.label, fontFamily: Fonts.label, flex: 1, fontSize: 12, letterSpacing: 1.4, color: c.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10, borderBottomWidth: 1,
    borderColor: c.separator },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 22, color: c.text },
  rowSub: { fontFamily: Fonts.label, fontSize: 13, letterSpacing: 0.3, lineHeight: 18, color: c.textSecondary, marginTop: 2 },
  noDriver: { color: c.textMuted },
  time: { fontFamily: Fonts.label, fontSize: 17, color: c.text, fontVariant: ['tabular-nums'] },
}));
