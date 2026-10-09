import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Notice, Tabs, useText } from '@/components/Picks';
import { TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { api, Debrief, Session } from '@/lib/api';
import { linkedLine } from '@/lib/debriefTime';
import { themed } from '@/constants/Theme';

const runName = (s: Session) => s.name ?? `Session ${s.id}`;

/** Which run a debrief goes with. One that joined its run by when it was recorded says why, with a Confirm, until it
 * is confirmed; every debrief keeps a Change, confirmed or older ones too (Gabriele, 2026-10-09). Change offers the
 * runs of the same event (else the newest) and moves the debrief there. */
export default function DebriefRun({ d, changed }: { d: Debrief; changed: (d: Debrief) => void }) {
  const styles = useStyles();
  const t = useText();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = d.linked?.by === 'time' && !d.linked.confirmed;

  useEffect(() => {
    api.sessions().then(setSessions, () => setSessions([]));
  }, []);

  const run = sessions.find((s) => s.id === d.session_id);
  const same = run?.event_name ? sessions.filter((s) => s.event_name === run.event_name) : [];
  const choices = (same.length > 1 ? same : sessions.slice(0, 8)).slice(0, 12);

  const set = async (sessionId: number) => {
    setBusy(true);
    setError(null);
    try {
      changed(await api.setDebriefRun(d.id, sessionId));
      setChanging(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const picker = changing && (
    <Tabs label="Goes with" value={d.session_id} onChange={(k) => k !== d.session_id && set(k)}
      items={choices.map((s) => ({ key: s.id, label: runName(s), disabled: busy }))} />
  );

  if (!open) {
    return (
      <View style={styles.quiet}>
        <View style={styles.links}>
          <Text style={t.body}>{`Goes with ${run ? runName(run) : 'its run'}.`}</Text>
          <TextLink label={changing ? 'Keep this run' : 'Change run'} onPress={() => setChanging((c) => !c)}
            disabled={busy} />
        </View>
        {picker}
        {error && <Text style={t.error}>{error}</Text>}
      </View>
    );
  }

  return (
    <Notice style={styles.notice}>
      <Text style={t.body}>{linkedLine(run ? runName(run) : 'the last run', d.linked?.minutes_after_run)}</Text>
      <View style={styles.links}>
        <TextLink label="Confirm" onPress={() => set(d.session_id)} disabled={busy} />
        <TextLink label={changing ? 'Keep this run' : 'Change'} onPress={() => setChanging((c) => !c)} disabled={busy} />
      </View>
      {picker}
      {error && <Text style={t.error}>{error}</Text>}
    </Notice>
  );
}

const useStyles = themed(() => ({
  notice: { marginTop: 20, gap: 12 },
  quiet: { marginTop: 16, gap: 12 },
  links: StyleSheet.flatten({ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 24, rowGap: 8 }),
}));
