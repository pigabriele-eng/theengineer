import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Choice, DriverChoice, toPick } from '@/components/DriverPicker';
import { Text, View, useThemeColor } from '@/components/Themed';
import { api, formatLap } from '@/lib/api';
import { Driver, driversApi, EventRow, Tagged } from '@/lib/drivers';

type Group = { key: string; title: string; eventId: number | null; sessions: Tagged[] };

// Tag sessions with their driver: tick sessions (or a whole event), pick the driver, set it for all of them.
export default function TagDriversScreen() {
  const [sessions, setSessions] = useState<Tagged[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
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
      const [s, e, d] = await Promise.all([api.sessions(), driversApi.events(), driversApi.list()]);
      setSessions(s as Tagged[]);
      setEvents(e);
      setDrivers(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    const byEvent = new Map<string, Group>();
    for (const s of [...sessions].sort((x, y) => (x.name ?? '').localeCompare(y.name ?? '', undefined, { numeric: true }))) {
      const ev = events.find((e) => e.id === s.event_id);
      const key = ev ? `e${ev.id}` : 'none';
      if (!byEvent.has(key)) byEvent.set(key, { key, title: ev ? ev.name : 'Not in an event', eventId: ev?.id ?? null, sessions: [] });
      byEvent.get(key)!.sessions.push(s);
    }
    return [...byEvent.values()].sort((a, b) => (a.eventId == null ? 1 : b.eventId == null ? -1 : b.eventId - a.eventId));
  }, [sessions, events]);

  const driverName = (id: number | null | undefined) => drivers.find((d) => d.id === id)?.name;
  const toggle = (ids: number[], on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
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
      setDone(`${r.session_ids.length} session${r.session_ids.length === 1 ? '' : 's'} now ${r.driver ? `driven by ${r.driver.name}` : 'without a driver'}.`);
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

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Tag drivers' }} />
      <Text style={styles.intro}>
        Tick the sessions one driver drove (or a whole event), pick the driver, and set it for all of them at once.
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
              ? `Tap again to remove ${driverName(choice.id)}: their sessions stay, without a driver`
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
              ? 'Tick the sessions below'
              : !ready
                ? `Pick the driver of ${picked.size} session${picked.size === 1 ? '' : 's'}`
                : `Set ${target} on ${picked.size} session${picked.size === 1 ? '' : 's'}`}
          </Text>
        )}
      </Pressable>
      {done && <Text style={styles.done}>{done}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}

      {groups.map((g) => {
        const ids = g.sessions.map((s) => s.id);
        const all = ids.every((id) => picked.has(id));
        return (
          <View key={g.key} style={styles.group}>
            <View style={styles.groupHead}>
              <Text style={styles.groupTitle} numberOfLines={1}>
                {g.title}
              </Text>
              <Pressable onPress={() => toggle(ids, !all)} hitSlop={8}>
                <Text style={{ color: tint }}>{all ? 'Untick all' : `Tick all ${ids.length}`}</Text>
              </Pressable>
            </View>
            {g.sessions.map((s) => {
              const on = picked.has(s.id);
              const who = driverName(s.driver_id);
              return (
                <Pressable
                  key={s.id}
                  onPress={() => toggle([s.id], !on)}
                  style={styles.row}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}>
                  <View style={StyleSheet.flatten([styles.box, on && { backgroundColor: tint, borderColor: tint }])}>
                    {on && <Text style={StyleSheet.flatten([styles.tick, { color: background }])}>✓</Text>}
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.title}>{s.name ?? `Session ${s.id}`}</Text>
                    <Text style={StyleSheet.flatten([styles.sub, !who && styles.dim])}>{who ?? 'no driver'}</Text>
                  </View>
                  <Text style={styles.time}>{formatLap(s.best_lap_s)}</Text>
                </Pressable>
              );
            })}
          </View>
        );
      })}
      {sessions.length === 0 && !error && <Text style={styles.dim}>No sessions yet.</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12 },
  intro: { opacity: 0.7, lineHeight: 20 },
  h2: { fontSize: 18, fontWeight: '700' },
  remove: { color: '#c8372d' },
  button: { borderRadius: 8, padding: 14, alignItems: 'center' },
  disabled: { opacity: 0.5 },
  buttonText: { fontWeight: '600', fontSize: 16 },
  done: { fontWeight: '600' },
  error: { color: '#c8372d' },
  group: { gap: 0, marginTop: 8 },
  groupHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 6 },
  groupTitle: { flex: 1, fontSize: 13, fontWeight: '600', opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderColor: '#8882' },
  box: { width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: '#8888', alignItems: 'center', justifyContent: 'center' },
  tick: { fontWeight: '700', fontSize: 14, lineHeight: 16 },
  rowText: { flex: 1, backgroundColor: 'transparent' },
  title: { fontSize: 16, fontWeight: '600' },
  sub: { opacity: 0.7, marginTop: 2 },
  dim: { opacity: 0.5 },
  time: { fontSize: 16, fontVariant: ['tabular-nums'] },
});
