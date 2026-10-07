// The other sessions of the same event, by day, one tap away: on a session page, and on the report and technique
// check when they show an event. The screen decides what a tap does (it keeps its place and swaps the session).
import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { api, formatLap } from '@/lib/api';
import { dateRange, dayTitle, eventsApi, Folder, FolderSession } from '@/lib/events';
import { noPrint } from '@/lib/print';
import { Fonts, themed, Type } from '@/constants/Theme';

/** An event with its sessions by day: null when there is none (eventId null) or until it is loaded. While eventId
 * is not known yet (undefined) the last event is kept, so a screen switching between sessions doesn't flicker. */
export function useEventFolder(eventId: number | null | undefined) {
  const [folder, setFolder] = useState<Folder | null>(null);
  useEffect(() => {
    if (eventId === undefined) return;
    if (eventId === null) {
      setFolder(null);
      return;
    }
    let live = true;
    eventsApi.folder(String(eventId)).then((f) => live && setFolder(f), () => live && setFolder(null));
    return () => {
      live = false;
    };
  }, [eventId]);
  return folder;
}

/** The event a session belongs to (null when none, undefined until known). */
export function useSessionEvent(sessionId: number | null | undefined) {
  const [eventId, setEventId] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (sessionId == null) {
      setEventId(undefined);
      return;
    }
    let live = true;
    api.session(sessionId).then(
      (s) => live && setEventId((s as { event_id?: number | null }).event_id ?? null),
      () => live && setEventId(null),
    );
    return () => {
      live = false;
    };
  }, [sessionId]);
  return eventId;
}

export function SessionSwitcher({ folder, current, onPick, onWhole, onlyTimed = false, link = true }: {
  folder: Folder;
  current: number | null; // the session shown; null when the whole event is
  onPick: (s: FolderSession) => void;
  onWhole?: () => void; // offers "Whole event" first
  onlyTimed?: boolean; // only sessions with a clean lap (what a report or a technique check can show)
  link?: boolean; // the event's name links to its page
}) {
  const styles = useStyles();
  const days = folder.days
    .map((d) => ({ ...d, sessions: d.sessions.filter((s) => !onlyTimed || s.best_lap_s != null) }))
    .filter((d) => d.sessions.length > 0);
  if (days.flatMap((d) => d.sessions).length < (onWhole ? 1 : 2)) return null;
  const range = dateRange(folder.start, folder.end);
  // a run in capitals over its best lap, the one shown underlined in red (one style object: a Pressable's style
  // reaches a web element as is)
  const run = (on: boolean) => StyleSheet.flatten([styles.run, on && styles.runOn]);

  return (
    // a picker: left off the printed page
    <View style={styles.box} accessibilityRole="tablist" {...noPrint}>
      <View style={styles.head}>
        {link && folder.id != null ? (
          // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
          <Link href={{ pathname: '/event/[id]', params: { id: folder.id } }} asChild>
            <Pressable hitSlop={6} style={styles.eventLink} accessibilityRole="link">
              <Text style={styles.event} numberOfLines={1}>{folder.name} →</Text>
            </Pressable>
          </Link>
        ) : (
          <Text style={styles.event} numberOfLines={1}>{folder.name}</Text>
        )}
        {range && <Text style={styles.sub}>{range}</Text>}
      </View>
      {onWhole && (
        <View style={styles.row}>
          <Pressable onPress={onWhole} style={run(current == null)} accessibilityRole="tab"
            accessibilityState={{ selected: current == null }}>
            <Text style={StyleSheet.flatten([styles.name, current == null && styles.nameOn])}>Whole event</Text>
            <Text style={styles.detail}>{formatLap(folder.best_lap_s)}</Text>
          </Pressable>
        </View>
      )}
      {days.map((d, i) => (
        <View key={d.date ?? 'none'} style={styles.day}>
          <Text style={styles.dayTitle}>{dayTitle(days, i)}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
            {d.sessions.map((s) => {
              const on = s.id === current;
              return (
                <Pressable key={s.id} onPress={() => !on && onPick(s)} style={run(on)} accessibilityRole="tab"
                  accessibilityState={{ selected: on }} accessibilityLabel={`${s.name}, best ${formatLap(s.best_lap_s)}`}>
                  <Text style={StyleSheet.flatten([styles.name, on && styles.nameOn, s.best_lap_s == null && styles.dim])}
                    numberOfLines={1}>
                    {s.name}
                  </Text>
                  <Text style={StyleSheet.flatten([styles.detail, s.best_lap_s == null && styles.dim])}>
                    {s.best_lap_s != null ? formatLap(s.best_lap_s) : s.time ?? 'no laps'}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ))}
    </View>
  );
}

// The race programme: no boxes, a thin ink rule under the strip, runs as capitals over their best lap, the one shown
// underlined in programme red.
const useStyles = themed((c) => ({
  box: { gap: 8, paddingTop: 12, paddingBottom: 10, borderBottomWidth: 1, borderColor: c.rule, backgroundColor: 'transparent' },
  head: { flexDirection: 'row', alignItems: 'baseline', columnGap: 12, rowGap: 2, flexWrap: 'wrap',
    backgroundColor: 'transparent' },
  eventLink: { flexShrink: 1, borderBottomWidth: 2, borderColor: c.rule },
  event: { ...Type.link, fontSize: 13, color: c.text },
  sub: { ...Type.label, fontFamily: Fonts.label, fontSize: 11, letterSpacing: 1, color: c.textMuted },
  day: { gap: 4, backgroundColor: 'transparent' },
  dayTitle: { ...Type.label, fontSize: 11, letterSpacing: 1.1, color: c.textMuted },
  row: { flexDirection: 'row', gap: 18, backgroundColor: 'transparent' },
  run: { maxWidth: 190, paddingBottom: 3, borderBottomWidth: 3, borderColor: 'transparent' },
  runOn: { borderColor: c.mark },
  name: { ...Type.label, fontSize: 13, letterSpacing: 0.8, color: c.textSecondary },
  nameOn: { color: c.text },
  detail: { ...Type.number, fontSize: 13, color: c.textMuted },
  dim: { opacity: 0.45 },
}));
