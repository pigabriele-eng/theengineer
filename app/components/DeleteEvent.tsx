// Deleting an event, the same on its page and on the Sessions list: its runs and their logs, keeping the event, empty,
// for the right logs (Gabriele, 2026-10-09: "delete all data but keep the event in the app"; server/app/run_delete.py),
// the event with its runs and their logs, for good (it frees their storage), or only the folder (its runs stay, under
// Not in an event). What a full delete would remove is asked first (server/app/event_delete.py), so the choice says how
// many runs and how much storage. The runs in no event ("Not in an event", id NO_EVENT) are deleted the same way, all
// at once, with no folder to keep. In the programme's way: the question in Anton, the red line that it can't be undone,
// then the choices one under the other, each with what it does: the two deletes as red blocks, removing only the
// folder and keeping it as text links.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, ViewStyle } from 'react-native';

import { ErrorLine, MainButton, Note, Said } from '@/components/Controls';
import { Label, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { EventDeleted, EventEmptied, EventSize, eventsApi, NO_EVENT, storageSize } from '@/lib/events';
import { Fonts, themed } from '@/constants/Theme';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const NOTICE: ViewStyle = { marginTop: 16 };

type How = 'empty' | 'runs' | 'folder';

/** What a full delete removed, in a line. */
const deletedLine = (d: EventDeleted) => `${d.deleted == null ? `Deleted the ${plural(d.runs, 'run')} not in an event`
  : `Deleted “${d.name}” with ${plural(d.runs, 'run')}`} and ${plural(d.files, 'stored file')}${
  d.bytes ? `: ${storageSize(d.bytes)} freed` : ''}.`;

/** What deleting an event's runs removed, in a line: the event stays. */
export const emptiedLine = (d: EventEmptied) => `Deleted the ${plural(d.runs, 'run')} of “${d.name}” and ${
  plural(d.files, 'stored file')}${d.bytes ? `: ${storageSize(d.bytes)} freed` : ''}. The event stays, empty: upload the right logs into it.`;

// The last delete, said on the Sessions list: after a full one on its page, the event's page is gone.
let lastDeleted: string | null = null;
const listeners = new Set<() => void>();
const setLastDeleted = (d: string | null) => {
  lastDeleted = d;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The choice: delete the runs and their logs and keep the event, or the event too (danger, both), only the folder
 * (quiet), or keep it. NO_EVENT: the runs in no event, deleted or kept. said: what went, in a line, after 'empty'. */
export function DeleteEvent({ id, name, onDeleted, onCancel }: {
  id: number | typeof NO_EVENT;
  name: string;
  onDeleted: (how: How, said?: string) => void;
  onCancel: () => void;
}) {
  const styles = useStyles();
  const wide = useWide();
  const [size, setSize] = useState<EventSize | null>(null);
  const [busy, setBusy] = useState<How | null>(null);
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

  const remove = async (how: How) => {
    setBusy(how);
    setError(null);
    try {
      if (how === 'empty' && id !== NO_EVENT) {
        onDeleted(how, emptiedLine(await eventsApi.removeRuns(id)));
        return;
      }
      if (how === 'runs') setLastDeleted(deletedLine(await eventsApi.removeWithRuns(id)));
      else if (id !== NO_EVENT) await eventsApi.remove(id);
      onDeleted(how);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const runs = size?.runs ?? 0;
  const frees = size?.bytes ? ` (frees ${storageSize(size.bytes)})` : '';
  const loose = id === NO_EVENT;
  return (
    <View style={styles.box}>
      <Label>{loose ? 'Delete the runs' : 'Delete the runs or the event'}</Label>
      <Text style={wide ? styles.title : styles.titlePhone}>
        {loose ? 'Delete the runs not in an event?' : <>Delete &ldquo;{name}&rdquo;?</>}
      </Text>
      {!size && !error && <ActivityIndicator style={styles.spinner} />}
      {size && runs > 0 && (
        <>
          <Text style={styles.text}>
            It holds {plural(runs, 'run')} with {plural(size.laps, 'lap')} and {plural(size.logs, 'log')}
            {size.bytes ? `, ${storageSize(size.bytes)} of storage` : ''}.
          </Text>
          <Text style={styles.warning}>
            Deleting the runs can&apos;t be undone: they go for good, with their logs, laps, debriefs, setup sheets and
            everything worked out from them.
          </Text>
        </>
      )}
      {size && runs === 0 && (
        <Text style={styles.text}>{loose ? 'There are no runs here.' : 'It has no runs: only the event goes.'}</Text>
      )}
      {size && (
        <View style={styles.choices}>
          {runs > 0 && !loose && (
            <View style={styles.choice}>
              <MainButton danger busy={busy === 'empty'} disabled={busy != null} onPress={() => remove('empty')}
                label={`Delete the ${plural(runs, 'run')} and their logs, keep the event${frees}`} />
              <Note>The event stays, empty, with its name, days and season: upload the right logs into it.</Note>
            </View>
          )}
          {(runs > 0 || !loose) && (
            <View style={styles.choice}>
              <MainButton danger busy={busy === 'runs'} disabled={busy != null} onPress={() => remove('runs')}
                label={loose ? `Delete these ${plural(runs, 'run')} and their logs${frees}`
                  : runs > 0 ? `Delete the event, its ${plural(runs, 'run')} and their logs${frees}` : 'Delete the event'} />
              {runs > 0 && !loose && <Note>The event goes too.</Note>}
            </View>
          )}
          {runs > 0 && !loose && (
            <View style={styles.choice}>
              <TextLink label="Only remove the folder, keep the runs" onPress={() => remove('folder')}
                disabled={busy != null} />
              <Note>They stay, with their logs, under Not in an event.</Note>
            </View>
          )}
          <View style={styles.choice}>
            <TextLink label="Keep it" onPress={onCancel} disabled={busy != null} />
            <Note>Nothing changes.</Note>
          </View>
        </View>
      )}
      {!size && error && <TextLink label="Keep it" onPress={onCancel} />}
      {busy && (
        <View style={styles.busy}>
          <ActivityIndicator />
          <Note>{busy === 'folder' ? 'Removing the folder…' : 'Deleting the runs and their logs…'}</Note>
        </View>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
    </View>
  );
}

/** "Delete" on an event of the Sessions list (or on its runs not in an event, NO_EVENT); the choice opens in a ruled band
 * under it. */
export function DeleteEventAction({ id, name, onDeleted }: {
  id: number | typeof NO_EVENT;
  name: string;
  onDeleted: () => void;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  return (
    <>
      <TextLink label={open ? 'Close' : 'Delete'} onPress={() => setOpen(!open)} small />
      {open && (
        <View style={styles.under}>
          <DeleteEvent id={id} name={name} onCancel={() => setOpen(false)}
            onDeleted={(how, said) => {
              if (said) setLastDeleted(said);
              setOpen(false);
              onDeleted();
            }} />
        </View>
      )}
    </>
  );
}

/** What the last delete removed, until dismissed (tap it). */
export function DeletedNotice() {
  const said = useSyncExternalStore(subscribe, () => lastDeleted, () => lastDeleted);
  if (!said) return null;
  return (
    <View style={NOTICE}>
      <Said onPress={() => setLastDeleted(null)} text={said} />
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { gap: 12 },
  title: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 32, textTransform: 'uppercase', color: c.text },
  titlePhone: { fontFamily: Fonts.display, fontSize: 23, lineHeight: 27, textTransform: 'uppercase', color: c.text },
  spinner: { alignSelf: 'flex-start' },
  text: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.text },
  warning: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.error, borderLeftWidth: 3,
    borderColor: c.error, paddingLeft: 10 },
  choices: { marginTop: 4, borderTopWidth: 1, borderColor: c.rule },
  choice: { gap: 6, alignItems: 'flex-start', paddingVertical: 12, borderBottomWidth: 1, borderColor: c.separator },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  under: { width: '100%', marginTop: 6, borderTopWidth: 3, borderColor: c.error, paddingTop: 12 },
}));
