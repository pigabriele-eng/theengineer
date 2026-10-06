import { Link, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions } from 'react-native';

import { LineKey, useLapColors } from '@/components/CompareViews';
import { EventCompare, Pick } from '@/components/EventCompare';
import { EventForm } from '@/components/EventForm';
import { ImportLogs } from '@/components/ImportLogs';
import { MoveSessions } from '@/components/MoveSessions';
import { RenameEvent } from '@/components/RenameEvent';
import { ResultsPanel } from '@/components/ResultsPanel';
import { filledNote, localPick, PickerKind, RunChips, RunNameEditor, RunPicker, useGarage } from '@/components/RunChips';
import { Text, View, useThemeColor } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { MAX_LAPS } from '@/lib/compare';
import {
  dateRange,
  dayTitle,
  eventsApi,
  Folder,
  FolderSession,
  KIND_NAMES,
  NO_EVENT,
} from '@/lib/events';
import { Garage, garageApi, RunFields } from '@/lib/garage';

// A run row as the server sends it, with its driver and car ids
type Run = FolderSession & { driver_id?: number | null; car_id?: number | null };

const WIDE = 900;
const freeSlot = (picks: Pick[]) => [0, 1, 2, 3, 4, 5].find((s) => !picks.some((p) => p.slot === s)) ?? 0;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One event as a folder: its sessions by day, each with its label, kind, best lap and laps; the event's report,
 * technique check and driver comparison one tap away; and any two to six sessions side by side on the same page.
 * Sessions are relabelled, picked and moved here. /event/none holds the sessions in no event. ?compare=3,12 keeps the
 * sessions side by side in the address. */
export default function EventScreen() {
  const params = useLocalSearchParams<{ id: string; compare?: string }>();
  const key = params.id === NO_EVENT ? NO_EVENT : String(Number(params.id));
  const router = useRouter();
  const [folder, setFolder] = useState<Folder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Pick[]>(() =>
    (params.compare ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)
      .filter((n, i, all) => all.indexOf(n) === i).slice(0, MAX_LAPS).map((id, slot) => ({ id, slot })));
  const [panel, setPanel] = useState<'edit' | 'move' | 'delete' | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // the run whose driver or car list is open, and what a pick did to other runs (said under the run picked)
  const [open, setOpen] = useState<{ id: number; what: PickerKind } | null>(null);
  const [runNote, setRunNote] = useState<{ id: number; text: string } | null>(null);
  const { garage, reload: reloadGarage } = useGarage();
  const scroll = useRef<ScrollView>(null);
  const compareY = useRef(0);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;

  const load = useCallback(() => {
    eventsApi.folder(key).then(
      (f) => {
        setFolder(f);
        setError(null);
        const ids = new Set(f.days.flatMap((d) => d.sessions.map((s) => s.id)));
        setPicks((ps) => (ps.every((p) => ids.has(p.id)) ? ps : ps.filter((p) => ids.has(p.id))));
      },
      (e) => setError((e as Error).message),
    );
  }, [key]);
  useFocusEffect(load);

  // the sessions side by side stay in the address, so going to a session and back keeps them
  const pickKey = picks.map((p) => p.id).join(',');
  useEffect(() => {
    if ((params.compare ?? '') !== pickKey) router.setParams({ compare: pickKey || undefined });
  }, [pickKey]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the picks change

  const sessions = useMemo(() => folder?.days.flatMap((d) => d.sessions) ?? [], [folder]);
  const toggle = (s: FolderSession) =>
    setPicks((ps) => {
      if (ps.some((p) => p.id === s.id)) return ps.filter((p) => p.id !== s.id);
      if (ps.length >= MAX_LAPS) return ps;
      return [...ps, { id: s.id, slot: freeSlot(ps) }];
    });
  const pickedColors = useLapColors(picks.map((p) => p.slot));
  const colorOf = (id: number) => {
    const i = picks.findIndex((p) => p.id === id);
    return i < 0 ? null : pickedColors.laps[i];
  };

  // one tap: the quickest session of each day (Friday's best against Sunday's, say)
  const bestOfDays = folder?.days
    .filter((d) => d.date)
    .map((d) => d.sessions.filter((s) => s.best_lap_s != null).sort((a, b) => a.best_lap_s! - b.best_lap_s!)[0])
    .filter((s): s is FolderSession => s != null)
    .slice(0, MAX_LAPS) ?? [];
  const pickBestOfDays = () => {
    setPicks(bestOfDays.map((s, slot) => ({ id: s.id, slot })));
    setTimeout(() => showCompare(), 50);
  };
  const showCompare = () => {
    if (!wide) scroll.current?.scrollTo({ y: Math.max(compareY.current - 12, 0), animated: true });
  };

  // a run's driver or car: the chip changes at once, the server's answer follows (with the logger's other runs
  // when the car went on them too)
  const patchRuns = (patch: (r: Run) => Run) =>
    setFolder((f) => f && { ...f, days: f.days.map((d) => ({ ...d, sessions: d.sessions.map((r) => patch(r as Run)) })) });
  const pickFor = async (s: Run, fields: RunFields) => {
    setOpen(null);
    const local = localPick(garage, fields);
    patchRuns((r) => (r.id === s.id ? { ...r, ...local } : r));
    try {
      const r = await garageApi.setRun(s.id, fields);
      const filled = new Set(r.filled);
      patchRuns((x) => (x.id === s.id ? { ...x, driver_id: r.driver_id, driver: r.driver, car_id: r.car_id }
        : filled.has(x.id) ? { ...x, car_id: r.car_id } : x));
      const note = filledNote(r);
      setRunNote(note ? { id: s.id, text: note } : null);
      reloadGarage();
    } catch (e) {
      setRunNote({ id: s.id, text: (e as Error).message });
      load();
    }
  };

  const moveTo = async (toKey: string, toName: string) => {
    const ids = picks.map((p) => p.id);
    await eventsApi.move(toKey, ids);
    setPicks([]);
    setPanel(null);
    setNotice(`Moved ${plural(ids.length, 'session')} to ${toName}. Reports of both events are being worked out again.`);
    load();
  };

  const isEvent = key !== NO_EVENT;
  const eventId = isEvent ? Number(key) : null;
  const range = folder ? dateRange(folder.start, folder.end) : null;
  const title = folder?.name ?? (isEvent ? 'Event' : 'Not in an event');
  const timed = sessions.some((s) => s.best_lap_s != null);

  const head = (
    <View style={styles.head}>
      {renaming && folder && eventId != null ? (
        <RenameEvent id={eventId} initial={folder.name} large onCancel={() => setRenaming(false)}
          onSaved={(f) => {
            setFolder(f);
            setRenaming(false);
          }} />
      ) : (
        <View style={styles.titleRow}>
          <Text style={styles.h1}>{title}</Text>
          {folder && eventId != null && (
            <Pressable onPress={() => setRenaming(true)} accessibilityRole="button" hitSlop={6}
              accessibilityLabel={`Rename ${folder.name}`}
              style={StyleSheet.flatten([styles.renameButton, { borderColor: tint }])}>
              <Text style={StyleSheet.flatten([styles.renameText, { color: tint }])}>✎ Rename</Text>
            </Pressable>
          )}
        </View>
      )}
      {folder && (
        <Text style={styles.sub}>
          {[folder.track, range, plural(folder.sessions, 'session'),
            folder.best_lap_s != null ? `best ${formatLap(folder.best_lap_s)}` : null].filter(Boolean).join(' · ')}
        </Text>
      )}
      {folder && isEvent && !folder.dates_by_hand && folder.log_start && (
        <Text style={styles.note}>Dates from the logs.</Text>
      )}
      {isEvent && eventId != null && (
        <View style={styles.actions}>
          {timed && (
            // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
            <Link href={{ pathname: '/report', params: { event: eventId } }} asChild>
              <Pressable style={StyleSheet.flatten([styles.action, { borderColor: tint }])}>
                <Text style={StyleSheet.flatten([styles.actionText, { color: tint }])}>Report</Text>
              </Pressable>
            </Link>
          )}
          {timed && (
            <Link href={{ pathname: '/technique', params: { event: eventId } }} asChild>
              <Pressable style={StyleSheet.flatten([styles.action, { borderColor: tint }])}>
                <Text style={StyleSheet.flatten([styles.actionText, { color: tint }])}>Technique check</Text>
              </Pressable>
            </Link>
          )}
          {timed && (
            <Link href={{ pathname: '/tools/stint', params: { event: eventId } }} asChild>
              <Pressable style={StyleSheet.flatten([styles.action, { borderColor: tint }])}>
                <Text style={StyleSheet.flatten([styles.actionText, { color: tint }])}>Stint analysis</Text>
              </Pressable>
            </Link>
          )}
          {timed && (
            <Link href={{ pathname: '/drivers/compare', params: { event: eventId } }} asChild>
              <Pressable style={StyleSheet.flatten([styles.action, { borderColor: tint }])}>
                <Text style={StyleSheet.flatten([styles.actionText, { color: tint }])}>Compare drivers</Text>
              </Pressable>
            </Link>
          )}
          <Pressable onPress={() => setPanel(panel === 'edit' ? null : 'edit')} accessibilityRole="button"
            style={StyleSheet.flatten([styles.action, styles.quiet])}>
            <Text style={styles.actionText}>Change dates</Text>
          </Pressable>
          <Pressable onPress={() => setPanel(panel === 'delete' ? null : 'delete')} accessibilityRole="button"
            style={StyleSheet.flatten([styles.action, styles.quiet])}>
            <Text style={styles.actionText}>Delete event</Text>
          </Pressable>
        </View>
      )}
      {panel === 'edit' && folder && eventId != null && (
        <View style={styles.panel}>
          <EventForm
            initial={{ name: folder.name, start: folder.dates_by_hand ? folder.start : null,
              end: folder.dates_by_hand ? folder.end : null }}
            datesHint={folder.log_start
              ? `Leave the dates empty to take them from the logs (${dateRange(folder.log_start, folder.log_end)}).`
              : 'Leave the dates empty to take them from the logs.'}
            submitLabel="Save"
            onCancel={() => setPanel(null)}
            onSubmit={async (v) => {
              setFolder(await eventsApi.update(eventId, v));
              setPanel(null);
            }}
          />
        </View>
      )}
      {panel === 'delete' && folder && eventId != null && (
        <View style={styles.panel}>
          <Text style={styles.confirm}>
            Delete the event &ldquo;{folder.name}&rdquo;? Only the folder goes: its {plural(folder.sessions, 'session')}{' '}
            and their logs stay, under Not in an event.
          </Text>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" style={StyleSheet.flatten([styles.action, styles.danger])}
              onPress={async () => {
                try {
                  await eventsApi.remove(eventId);
                  router.replace('/');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}>
              <Text style={StyleSheet.flatten([styles.actionText, styles.dangerText])}>Delete the event</Text>
            </Pressable>
            <Pressable onPress={() => setPanel(null)} accessibilityRole="button" style={styles.action}>
              <Text style={styles.actionText}>Keep it</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );

  const list = (
    <View style={styles.list}>
      {bestOfDays.length >= 2 && (
        <Pressable onPress={pickBestOfDays} accessibilityRole="button"
          style={StyleSheet.flatten([styles.quick, { borderColor: tint }])}>
          <Text style={StyleSheet.flatten([styles.quickText, { color: tint }])}>
            Side by side: the quickest session of each day
          </Text>
          <Text style={styles.note}>{bestOfDays.map((s) => s.name).join(' · ')}</Text>
        </Pressable>
      )}
      {sessions.length > 0 && (
        <Text style={styles.note}>
          Tick two to six sessions to see them side by side. Tap a session&apos;s name to rename it, its driver or car
          to set them, its time to open it.
        </Text>
      )}
      {folder?.days.map((d, i) => (
        <View key={d.date ?? 'none'} style={styles.day}>
          <Text style={styles.dayTitle}>{dayTitle(folder.days, i)}</Text>
          {d.sessions.map((s) => (
            <SessionRow key={s.id} s={s} color={colorOf(s.id)} picked={picks.some((p) => p.id === s.id)}
              full={picks.length >= MAX_LAPS} onToggle={() => toggle(s)} editing={editing === s.id}
              onEdit={() => setEditing(editing === s.id ? null : s.id)}
              onSaved={() => {
                setEditing(null);
                load();
              }}
              garage={garage} open={open?.id === s.id ? open.what : null}
              onOpen={(what) => setOpen(what ? { id: s.id, what } : null)} onPick={(fields) => pickFor(s, fields)}
              note={runNote?.id === s.id ? runNote.text : null} onNoteClose={() => setRunNote(null)} />
          ))}
        </View>
      ))}
      {folder && sessions.length === 0 && (
        <Text style={styles.note}>
          {isEvent
            ? 'No sessions in this event yet. Upload logs into it from the Sessions tab, or move sessions here from another event.'
            : 'Every session is in an event.'}
        </Text>
      )}
      {folder && isEvent && eventId != null && (
        <ImportLogs onProgress={load} into={{ id: eventId, name: folder.name }} />
      )}
      {folder && <AddSession eventId={eventId} onAdded={load} />}
    </View>
  );

  const compare = picks.length >= 2 ? (
    <View onLayout={(e) => (compareY.current = e.nativeEvent.layout.y)} style={styles.compare}>
      <EventCompare folderKey={key} picks={picks} onClear={() => setPicks([])} />
    </View>
  ) : wide ? (
    <View style={styles.compare}>
      <Text style={styles.h2}>Side by side</Text>
      <Text style={styles.note}>
        Tick two to six sessions on the left (FP1 on Friday and the race on Sunday, say) to see their lap times,
        section times, top speed and tyres here, next to each other.
      </Text>
    </View>
  ) : null;

  return (
    <View style={[styles.screen, { backgroundColor: background }]}>
      <Stack.Screen options={{ title }} />
      <ScrollView ref={scroll} style={styles.grow} contentContainerStyle={styles.outer}>
        <View style={styles.page}>
          {!folder && !error && <ActivityIndicator />}
          {error && <Text style={styles.error}>{error}</Text>}
          {head}
          {notice && (
            <Pressable onPress={() => setNotice(null)}>
              <Text style={styles.notice}>{notice}</Text>
            </Pressable>
          )}
          {eventId != null && <ResultsPanel eventId={eventId} />}
          {panel === 'move' && picks.length > 0 && (
            <MoveSessions fromKey={key} count={picks.length} onMove={moveTo} onCancel={() => setPanel(null)} />
          )}
          {wide ? (
            <View style={styles.columns}>
              <View style={styles.left}>{list}</View>
              <View style={styles.right}>{compare}</View>
            </View>
          ) : (
            <>
              {list}
              {compare}
            </>
          )}
        </View>
      </ScrollView>
      {picks.length > 0 && (
        <View style={styles.bar}>
          <Text style={styles.barText}>{picks.length} ticked</Text>
          {!wide && picks.length >= 2 && (
            <Pressable onPress={showCompare} accessibilityRole="button"
              style={StyleSheet.flatten([styles.barButton, { borderColor: tint }])}>
              <Text style={StyleSheet.flatten([styles.barButtonText, { color: tint }])}>Side by side ↓</Text>
            </Pressable>
          )}
          <Pressable onPress={() => {
            setPanel('move');
            scroll.current?.scrollTo({ y: 0, animated: true });
          }} accessibilityRole="button" style={StyleSheet.flatten([styles.barButton, { borderColor: tint }])}>
            <Text style={StyleSheet.flatten([styles.barButtonText, { color: tint }])}>Move…</Text>
          </Pressable>
          <Pressable onPress={() => setPicks([])} hitSlop={8} accessibilityRole="button">
            <Text style={{ color: tint }}>Clear</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** One run: tick it for side by side, tap its name to rename it in place, tap its driver or car chip to set them,
 * tap its laps or time to open it. */
function SessionRow({ s, color, picked, full, onToggle, editing, onEdit, onSaved, garage, open, onOpen, onPick, note,
  onNoteClose }: {
  s: Run;
  color: string | null;
  picked: boolean;
  full: boolean;
  onToggle: () => void;
  editing: boolean;
  onEdit: () => void;
  onSaved: () => void;
  garage: Garage | null;
  open: PickerKind | null;
  onOpen: (what: PickerKind | null) => void;
  onPick: (fields: RunFields) => void;
  note: string | null;
  onNoteClose: () => void;
}) {
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');
  const detail = [
    s.log_session && !s.name.includes(s.log_session) ? s.log_session : null,
    s.time,
    s.laps ? `${plural(s.laps, 'lap')}${s.clean_laps !== s.laps ? ` (${s.clean_laps} clean)` : ''}` : s.has_log ? 'no laps' : 'no log',
  ].filter(Boolean).join(' · ');
  const href = { pathname: '/session/[id]', params: { id: s.id } } as const;
  return (
    <View style={styles.sessionBox}>
      <View style={StyleSheet.flatten([styles.row, editing && styles.rowEditing])}>
        <Pressable onPress={onToggle} disabled={full && !picked} hitSlop={10} accessibilityRole="checkbox"
          accessibilityState={{ checked: picked }} accessibilityLabel={`Side by side: ${s.name}`}
          style={StyleSheet.flatten([styles.check, picked && { borderColor: tint, backgroundColor: tint },
            full && !picked && styles.dim])}>
          {picked && <Text style={StyleSheet.flatten([styles.tick, { color: background }])}>✓</Text>}
        </Pressable>
        <View style={styles.rowText}>
          {editing ? (
            <RunNameEditor id={s.id} name={s.name} kind={s.kind} logSession={s.log_session} onSaved={onSaved}
              onCancel={onEdit} save={(id, body) => eventsApi.updateSession(id, body)} />
          ) : (
            <View style={styles.nameLine}>
              {color && <LineKey color={color} />}
              <Pressable onPress={onEdit} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Rename ${s.name}`}
                style={styles.namePress}>
                <Text style={styles.name} numberOfLines={1}>{s.name}</Text>
                <Text style={StyleSheet.flatten([styles.pencil, { color: tint }])}>✎</Text>
              </Pressable>
              <View style={styles.kind}>
                <Text style={styles.kindText}>{KIND_NAMES[s.kind]}</Text>
              </View>
            </View>
          )}
          {/* Link asChild hands its child's style to a web anchor, which can't take a style array: one object */}
          <Link href={href} asChild>
            <Pressable style={styles.detailPress}>
              <Text style={styles.sub} numberOfLines={1}>{detail}</Text>
            </Pressable>
          </Link>
          <RunChips run={s} garage={garage} open={open} onOpen={onOpen} />
        </View>
        {/* while the name is edited, the editor takes the row's width */}
        {!editing && (
          <Link href={href} asChild>
            <Pressable style={styles.open} accessibilityLabel={`Open ${s.name}`}>
              <Text style={StyleSheet.flatten([styles.time, s.best_lap_s == null && styles.dim])}>
                {formatLap(s.best_lap_s)}
              </Text>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          </Link>
        )}
      </View>
      {open && garage && (
        <View style={styles.picker}>
          <RunPicker what={open} run={s} garage={garage} onPick={onPick} onClose={() => onOpen(null)} />
        </View>
      )}
      {note && (
        <Pressable onPress={onNoteClose} style={styles.picker}>
          <Text style={styles.notice}>{note}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** A session made by hand in this event (no logs yet: to upload one to it, or for a debrief). */
function AddSession({ eventId, onAdded }: { eventId: number | null; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" style={styles.addLink}>
        <Text style={{ color: tint }}>＋ Add a session by hand</Text>
      </Pressable>
    );
  }
  const add = async () => {
    try {
      await eventsApi.createSession({ name: name.trim() || 'New session', kind: 'practice', event_id: eventId });
      setName('');
      setOpen(false);
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <View style={styles.editRow}>
      <TextInput value={name} onChangeText={setName} placeholder="Label, e.g. FP2" placeholderTextColor="#888"
        maxLength={120} style={StyleSheet.flatten([styles.input, { color: text }])} onSubmitEditing={add} />
      <Pressable onPress={add} accessibilityRole="button" style={StyleSheet.flatten([styles.barButton, { borderColor: tint }])}>
        <Text style={StyleSheet.flatten([styles.barButtonText, { color: tint }])}>Add</Text>
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grow: { flex: 1 },
  outer: { padding: 16, paddingBottom: 32 },
  page: { width: '100%', maxWidth: 1180, alignSelf: 'center', gap: 16 },
  head: { gap: 6 },
  h1: { fontSize: 24, fontWeight: '700', flexShrink: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  renameButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  renameText: { fontWeight: '600', fontSize: 14 },
  h2: { fontSize: 18, fontWeight: '700' },
  sub: { opacity: 0.65, fontSize: 13 },
  note: { fontSize: 12, opacity: 0.6 },
  notice: { fontSize: 13, opacity: 0.8, borderLeftWidth: 3, borderColor: '#8886', paddingLeft: 8 },
  error: { color: '#c8372d' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  action: { borderWidth: 1, borderColor: '#8884', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  actionText: { fontWeight: '600', fontSize: 14 },
  quiet: { borderStyle: 'dashed' },
  danger: { borderColor: '#c8372d' },
  dangerText: { color: '#c8372d' },
  panel: { borderWidth: 1, borderColor: '#8884', borderRadius: 10, padding: 12, gap: 8, marginTop: 6 },
  confirm: { fontSize: 15, lineHeight: 21 },
  columns: { flexDirection: 'row', gap: 24, alignItems: 'flex-start' },
  left: { flex: 1, minWidth: 360, maxWidth: 480 },
  right: { flex: 1.4 },
  list: { gap: 12 },
  compare: { gap: 8, marginTop: 8 },
  quick: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, gap: 2 },
  quickText: { fontWeight: '600', fontSize: 15 },
  day: { gap: 0 },
  dayTitle: { fontSize: 12, fontWeight: '700', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5,
    paddingTop: 8, paddingBottom: 4, borderBottomWidth: 1, borderColor: '#8884' },
  sessionBox: { borderBottomWidth: 1, borderColor: '#8882' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  check: { width: 22, height: 22, borderRadius: 5, borderWidth: 1.5, borderColor: '#8888', alignItems: 'center',
    justifyContent: 'center' },
  tick: { fontSize: 14, fontWeight: '800', lineHeight: 16 },
  rowEditing: { alignItems: 'flex-start' },
  rowText: { flex: 1, gap: 4, backgroundColor: 'transparent' },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'transparent' },
  namePress: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  name: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  pencil: { fontSize: 13 },
  detailPress: { alignSelf: 'stretch' },
  kind: { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: '#8882' },
  kindText: { fontSize: 11, fontWeight: '600', opacity: 0.8 },
  open: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'stretch', paddingLeft: 6 },
  time: { fontSize: 16, fontVariant: ['tabular-nums'] },
  chevron: { fontSize: 22, opacity: 0.4 },
  dim: { opacity: 0.4 },
  picker: { paddingLeft: 32 },
  editRow: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  input: { flex: 1, minWidth: 140, borderWidth: 1, borderColor: '#8884', borderRadius: 8, paddingHorizontal: 10,
    paddingVertical: 8, fontSize: 15 },
  addLink: { paddingVertical: 8 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10,
    borderTopWidth: 1, borderColor: '#8884', flexWrap: 'wrap' },
  barText: { fontWeight: '600', marginRight: 'auto' },
  barButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  barButtonText: { fontWeight: '600' },
});
