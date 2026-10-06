import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Choice, DriverChoice, toPick } from '@/components/DriverPicker';
import { Text, View, useThemeColor } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { todayIso } from '@/lib/calendar';
import { Driver, driversApi } from '@/lib/drivers';
import { dateRange, dayLabel, dayTitle, Folder } from '@/lib/events';
import { firstOpen, loadBlocks, Outing, outingsOf, withoutDriver } from '@/lib/tagging';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Tag outings with their driver: tick outings (or a whole event or day), pick the driver, set it for all of them.
// One block per event as the Sessions tab shows them, newest first; the event on now (else the newest) opens.
export default function TagDriversScreen() {
  const [blocks, setBlocks] = useState<Folder[] | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [choice, setChoice] = useState<Choice | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');

  const load = useCallback(async () => {
    try {
      const [b, d] = await Promise.all([loadBlocks(), driversApi.list()]);
      setBlocks(b);
      setDrivers(d);
      setOpen((o) => o ?? new Set([firstOpen(b, todayIso())].filter((k): k is string => k != null)));
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
  const tickAll = (outings: Outing[], label: string) => {
    const ids = outings.map((o) => o.id);
    const all = ids.every((id) => picked.has(id));
    return (
      <Pressable onPress={() => toggle(ids, !all)} hitSlop={8} accessibilityRole="button"
        accessibilityLabel={`${all ? 'Untick' : 'Tick'} all of ${label}`}>
        <Text style={StyleSheet.flatten([styles.tickAll, { color: tint }])}>{all ? 'Untick all' : `Tick all ${ids.length}`}</Text>
      </Pressable>
    );
  };

  const row = (o: Outing) => {
    const on = picked.has(o.id);
    const who = o.driver ?? driverName(o.driver_id);
    return (
      <Pressable
        key={o.id}
        onPress={() => toggle([o.id], !on)}
        style={styles.row}
        accessibilityRole="checkbox"
        aria-checked={on}>
        <View style={StyleSheet.flatten([styles.box, on && { backgroundColor: tint, borderColor: tint }])}>
          {on && <Text style={StyleSheet.flatten([styles.tick, { color: background }])}>✓</Text>}
        </View>
        <View style={styles.rowText}>
          <Text style={styles.title}>{o.name}</Text>
          <Text style={StyleSheet.flatten([styles.sub, !who && styles.dim])}>
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
      <View key={b.key} style={StyleSheet.flatten([styles.block, loose && styles.loose])}>
        <View style={styles.head}>
          <Pressable onPress={() => flip(b.key)} style={styles.headText} accessibilityRole="button"
            aria-expanded={isOpen} accessibilityLabel={`${b.name}, ${summary}`}>
            <Text style={styles.chevron}>{isOpen ? '▾' : '▸'}</Text>
            <View style={styles.headWords}>
              <Text style={styles.blockTitle} numberOfLines={2}>{b.name}</Text>
              <Text style={styles.summary}>{summary}</Text>
            </View>
          </Pressable>
          {tickAll(outings, b.name)}
        </View>
        {isOpen && b.days.map((d, i) => {
          const title = loose ? (d.date ? dayLabel(d.date, { long: true, year: true }) : 'Date not known') : dayTitle(b.days, i);
          return (
            <View key={d.date ?? 'undated'} style={styles.day}>
              <View style={styles.dayHead}>
                <Text style={styles.dayTitle} numberOfLines={1}>{title}</Text>
                {tickAll(d.sessions, title)}
              </View>
              {(d.sessions as Outing[]).map(row)}
            </View>
          );
        })}
      </View>
    );
  };

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.outer}>
      <Stack.Screen options={{ title: 'Tag drivers' }} />
      <View style={styles.page}>
        <Text style={styles.intro}>
          Tick the outings one driver drove (or a whole event or day), pick the driver, and set it for all of them at once.
        </Text>

        <Text style={styles.h2}>Driver</Text>
        <DriverChoice
          drivers={drivers}
          value={choice}
          onChange={(c) => {
            setChoice(c);
            setConfirmRemove(false);
          }}
        />
        {choice != null && 'id' in choice && (
          <Pressable onPress={remove} hitSlop={8}>
            <Text style={styles.remove}>
              {confirmRemove
                ? `Tap again to remove ${driverName(choice.id)}: their outings stay, without a driver`
                : `Remove ${driverName(choice.id)}`}
            </Text>
          </Pressable>
        )}

        <Pressable
          onPress={apply}
          disabled={!ready || busy}
          style={StyleSheet.flatten([styles.button, { backgroundColor: tint }, (!ready || busy) && styles.disabled])}>
          {busy ? (
            <ActivityIndicator color={background} />
          ) : (
            <Text style={StyleSheet.flatten([styles.buttonText, { color: background }])}>
              {picked.size === 0
                ? 'Tick the outings below'
                : !ready
                  ? `Pick the driver of ${plural(picked.size, 'outing')}`
                  : `Set ${target} on ${plural(picked.size, 'outing')}`}
            </Text>
          )}
        </Pressable>
        {done && <Text style={styles.done}>{done}</Text>}
        {error && <Text style={styles.error}>{error}</Text>}

        {!blocks && !error && <ActivityIndicator />}
        {blocks?.map(block)}
        {blocks?.length === 0 && <Text style={styles.dim}>No outings yet.</Text>}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  outer: { padding: 16, paddingBottom: 32 },
  page: { width: '100%', maxWidth: 820, alignSelf: 'center', gap: 12 },
  intro: { opacity: 0.7, lineHeight: 20 },
  h2: { fontSize: 18, fontWeight: '700' },
  remove: { color: '#c8372d' },
  button: { borderRadius: 8, padding: 14, alignItems: 'center' },
  disabled: { opacity: 0.5 },
  buttonText: { fontWeight: '600', fontSize: 16 },
  done: { fontWeight: '600' },
  error: { color: '#c8372d' },
  block: { borderWidth: 1, borderColor: '#8884', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  loose: { borderStyle: 'dashed' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: 'transparent' },
  headText: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 2 },
  chevron: { fontSize: 16, lineHeight: 22, width: 14, opacity: 0.6 },
  headWords: { flex: 1, gap: 2, backgroundColor: 'transparent' },
  blockTitle: { fontSize: 17, fontWeight: '700' },
  summary: { opacity: 0.65, fontSize: 13, lineHeight: 18 },
  tickAll: { fontWeight: '600' },
  day: { marginTop: 10, backgroundColor: 'transparent' },
  dayHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 6,
    backgroundColor: 'transparent' },
  dayTitle: { flex: 1, fontSize: 13, fontWeight: '600', opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: 1, borderColor: '#8882' },
  box: { width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: '#8888', alignItems: 'center', justifyContent: 'center' },
  tick: { fontWeight: '700', fontSize: 14, lineHeight: 16 },
  rowText: { flex: 1, backgroundColor: 'transparent' },
  title: { fontSize: 16, fontWeight: '600' },
  sub: { opacity: 0.7, marginTop: 2 },
  dim: { opacity: 0.5 },
  time: { fontSize: 16, fontVariant: ['tabular-nums'] },
});
