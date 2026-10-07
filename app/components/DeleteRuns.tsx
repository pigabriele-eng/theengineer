// Deleting the runs ticked on an event's page (or among the runs in no event), for good: one confirm, in the same way
// as deleting the event (components/DeleteEvent.tsx). What it would remove is asked first (server/app/run_delete.py),
// so the button says how many runs and how much storage. The event stays, with its other runs.
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { ErrorLine, MainButton, Note } from '@/components/Controls';
import { Label, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { RunsDeleted, runsApi, RunsSize } from '@/lib/deleteRuns';
import { storageSize } from '@/lib/events';
import { face, Fonts, themed } from '@/constants/Theme';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The confirm: delete the ticked runs with their logs (danger), or cancel. */
export function DeleteRuns({ ids, names, inEvent, onDeleted, onCancel, title = 'Delete the ticked runs' }: {
  ids: number[];
  names: string[]; // the runs' names, in the order ticked
  inEvent: boolean; // false: runs in no event
  onDeleted: (d: RunsDeleted) => void;
  onCancel: () => void;
  title?: string; // its label: one run swiped or held on its row (components/RunActions.tsx) says so
}) {
  const styles = useStyles();
  const wide = useWide();
  const [size, setSize] = useState<RunsSize | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = ids.join(',');

  useEffect(() => {
    let live = true;
    setSize(null);
    setError(null);
    runsApi.size(ids).then(
      (s) => live && setSize(s),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the ticked runs change

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      onDeleted(await runsApi.remove(ids));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const frees = size?.bytes ? ` (frees ${storageSize(size.bytes)})` : '';
  const one = ids.length === 1;
  return (
    <View style={styles.box}>
      <Label>{title}</Label>
      <Text style={wide ? styles.title : styles.titlePhone}>Delete {one ? 'this run' : `these ${ids.length} runs`}?</Text>
      <Text style={styles.names}>{names.join(' · ')}</Text>
      {!size && !error && <ActivityIndicator style={styles.spinner} />}
      {size && (
        <>
          <Text style={styles.text}>
            {one ? 'It holds' : 'They hold'} {plural(size.laps, 'lap')} and {plural(size.logs, 'log')}
            {size.bytes ? `, ${storageSize(size.bytes)} of storage` : ''}.{inEvent ? ' The event and its other runs stay.' : ''}
          </Text>
          <Text style={styles.warning}>
            {one
              ? `This can’t be undone: the run goes for good, with its ${size.logs === 1 ? 'log' : 'logs'}, laps, debriefs, setup sheet and everything worked out from it.`
              : 'This can’t be undone: the runs go for good, with their logs, laps, debriefs, setup sheets and everything worked out from them.'}
          </Text>
          <View style={styles.choices}>
            <View style={styles.choice}>
              <MainButton danger busy={busy} disabled={busy} onPress={remove}
                label={`Delete ${one ? `this run and its ${size.logs === 1 ? 'log' : 'logs'}`
                  : `these ${ids.length} runs and their logs`}${frees}`} />
            </View>
            <View style={styles.choice}>
              <TextLink label="Cancel" onPress={onCancel} disabled={busy} />
              <Note>Nothing changes.</Note>
            </View>
          </View>
        </>
      )}
      {!size && error && <TextLink label="Cancel" onPress={onCancel} />}
      {busy && (
        <View style={styles.busy}>
          <ActivityIndicator />
          <Note>{one ? 'Deleting the run and its log…' : 'Deleting the runs and their logs…'}</Note>
        </View>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
    </View>
  );
}

/** What a delete removed, said on the page: "Deleted 2 runs (01_D1S1, 02_D1S2) and 4 stored files: 140 MB freed." */
export function deletedLine(d: RunsDeleted) {
  return `Deleted ${plural(d.runs, 'run')} (${d.name}) and ${plural(d.files, 'stored file')}${
    d.bytes ? `: ${storageSize(d.bytes)} freed` : ''}.${d.events.length ? ' The event’s report and pages are being worked out again.' : ''}`;
}

const useStyles = themed((c) => ({
  box: { gap: 12 },
  title: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 32, textTransform: 'uppercase', color: c.text },
  titlePhone: { fontFamily: Fonts.display, fontSize: 23, lineHeight: 27, textTransform: 'uppercase', color: c.text },
  names: { fontFamily: face('body', 400, true), fontSize: 17, lineHeight: 24, color: c.text },
  spinner: { alignSelf: 'flex-start' },
  text: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.text },
  warning: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.error, borderLeftWidth: 3,
    borderColor: c.error, paddingLeft: 10 },
  choices: { marginTop: 4, borderTopWidth: 1, borderColor: c.rule },
  choice: { gap: 6, alignItems: 'flex-start', paddingVertical: 12, borderBottomWidth: 1, borderColor: c.separator },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 10 },
}));
