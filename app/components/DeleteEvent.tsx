// Deleting an event, the same on its page and on the Sessions list: with its runs and their logs, for good (it frees
// their storage), or only the folder (its runs stay, under Not in an event). What a full delete would remove is asked
// first (server/app/event_delete.py), so the choice says how many runs and how much storage.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { EventDeleted, EventSize, eventsApi, storageSize } from '@/lib/events';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The last full delete, said on the Sessions list: after one on its page, the event's page is gone.
let lastDeleted: EventDeleted | null = null;
const listeners = new Set<() => void>();
const setLastDeleted = (d: EventDeleted | null) => {
  lastDeleted = d;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The choice: delete the event with its runs and logs (danger), only the folder (quiet), or keep it. */
export function DeleteEvent({ id, name, onDeleted, onCancel }: {
  id: number;
  name: string;
  onDeleted: (how: 'runs' | 'folder') => void;
  onCancel: () => void;
}) {
  const [size, setSize] = useState<EventSize | null>(null);
  const [busy, setBusy] = useState<'runs' | 'folder' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    eventsApi.size(id).then(
      (s) => live && setSize(s),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [id]);

  const remove = async (how: 'runs' | 'folder') => {
    setBusy(how);
    setError(null);
    try {
      if (how === 'runs') setLastDeleted(await eventsApi.removeWithRuns(id));
      else await eventsApi.remove(id);
      onDeleted(how);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const runs = size?.runs ?? 0;
  const frees = size?.bytes ? ` (frees ${storageSize(size.bytes)})` : '';
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Delete &ldquo;{name}&rdquo;?</Text>
      {!size && !error && <ActivityIndicator style={styles.spinner} />}
      {size && runs > 0 && (
        <>
          <Text style={styles.text}>
            It holds {plural(runs, 'run')} with {plural(size.laps, 'lap')} and {plural(size.logs, 'log')}
            {size.bytes ? `, ${storageSize(size.bytes)} of storage` : ''}.
          </Text>
          <Text style={StyleSheet.flatten([styles.text, styles.warning])}>
            Deleting the runs can&apos;t be undone: they go for good, with their logs, laps, debriefs, setup sheets and
            everything worked out from them.
          </Text>
          <Pressable onPress={() => remove('runs')} disabled={busy != null} accessibilityRole="button"
            style={StyleSheet.flatten([styles.button, styles.danger, busy != null && styles.dim])}>
            <Text style={styles.dangerText}>Delete the event, its {plural(runs, 'run')} and their logs{frees}</Text>
          </Pressable>
          <Pressable onPress={() => remove('folder')} disabled={busy != null} accessibilityRole="button"
            style={StyleSheet.flatten([styles.button, styles.quiet, busy != null && styles.dim])}>
            <Text style={styles.buttonText}>Only remove the folder, keep the runs</Text>
            <Text style={styles.hint}>They stay, with their logs, under Not in an event.</Text>
          </Pressable>
        </>
      )}
      {size && runs === 0 && (
        <>
          <Text style={styles.text}>It has no runs: only the event goes.</Text>
          <Pressable onPress={() => remove('runs')} disabled={busy != null} accessibilityRole="button"
            style={StyleSheet.flatten([styles.button, styles.danger, busy != null && styles.dim])}>
            <Text style={styles.dangerText}>Delete the event</Text>
          </Pressable>
        </>
      )}
      <Pressable onPress={onCancel} disabled={busy != null} accessibilityRole="button" style={styles.button}>
        <Text style={styles.buttonText}>Keep it</Text>
      </Pressable>
      {busy && (
        <View style={styles.busy}>
          <ActivityIndicator />
          <Text style={styles.hint}>{busy === 'runs' ? 'Deleting the runs and their logs…' : 'Removing the folder…'}</Text>
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

/** "✕ Delete" on an event of the Sessions list; the choice opens under it. */
export function DeleteEventAction({ id, name, onDeleted }: { id: number; name: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const tint = useThemeColor({}, 'tint');
  return (
    <>
      <Pressable onPress={() => setOpen(!open)} hitSlop={8} accessibilityRole="button"
        accessibilityLabel={`Delete ${name}`} style={styles.link}>
        <Text style={StyleSheet.flatten([styles.linkText, { color: tint }])}>✕ Delete</Text>
      </Pressable>
      {open && (
        <View style={styles.under}>
          <DeleteEvent id={id} name={name} onCancel={() => setOpen(false)}
            onDeleted={() => {
              setOpen(false);
              onDeleted();
            }} />
        </View>
      )}
    </>
  );
}

/** What the last full delete removed, until dismissed. */
export function DeletedNotice() {
  const d = useSyncExternalStore(subscribe, () => lastDeleted, () => lastDeleted);
  if (!d) return null;
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeText}>
        Deleted &ldquo;{d.name}&rdquo; with {plural(d.runs, 'run')} and {plural(d.files, 'stored file')}
        {d.bytes ? `: ${storageSize(d.bytes)} freed` : ''}.
      </Text>
      <Pressable onPress={() => setLastDeleted(null)} hitSlop={8} accessibilityRole="button"
        accessibilityLabel="Dismiss">
        <Text style={styles.hint}>✕</Text>
      </Pressable>
    </View>
  );
}

const RED = '#c8372d';

const styles = StyleSheet.create({
  box: { gap: 10, backgroundColor: 'transparent' },
  title: { fontSize: 16, fontWeight: '700' },
  spinner: { alignSelf: 'flex-start' },
  text: { fontSize: 15, lineHeight: 21 },
  warning: { color: RED },
  button: { alignSelf: 'flex-start', maxWidth: '100%', borderWidth: 1, borderColor: '#8884', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 9, gap: 2 },
  danger: { borderColor: RED, backgroundColor: '#c8372d14' },
  dangerText: { color: RED, fontWeight: '700', fontSize: 15 },
  quiet: { borderStyle: 'dashed' },
  buttonText: { fontWeight: '600', fontSize: 15 },
  hint: { fontSize: 12, opacity: 0.6 },
  dim: { opacity: 0.5 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'transparent' },
  error: { color: RED },
  link: { paddingVertical: 2 },
  linkText: { fontWeight: '600', fontSize: 14 },
  under: { width: '100%', borderTopWidth: 1, borderColor: '#8884', paddingTop: 10, marginTop: 2,
    backgroundColor: 'transparent' },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderLeftWidth: 3, borderColor: RED,
    paddingLeft: 10, paddingVertical: 4 },
  noticeText: { flex: 1, fontSize: 14, lineHeight: 20 },
});
