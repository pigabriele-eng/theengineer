import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Tabs, useText } from '@/components/Picks';
import { TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { api, Debrief, DebriefCovers as Covers } from '@/lib/api';
import { coversLine } from '@/lib/debriefCovers';
import { themed } from '@/constants/Theme';

const OUT = -1;
const MOST = 4; // the server checks up to four runs together (server/app/debrief/covers.py MOST)

/** The stints a debrief talks about. A driver often debriefs once at the end of FP1 about all its stints, with
 * changes made between two of them (Gabriele, 2026-10-09): the debrief covers the session's stints, split where the
 * setup sheets differ, and here the user picks the stints and marks where the setup changed when no sheet says so.
 * `changed` is called after a save, so the check against the data is read again. */
export default function DebriefCovers({ d, changed }: { d: Debrief; changed: () => void }) {
  const styles = useStyles();
  const t = useText();
  const [c, setC] = useState<Covers | null>(null);
  const [draft, setDraft] = useState<Record<number, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.debriefRuns(d.id).then((r) => live && setC(r), () => live && setC(null));
    return () => {
      live = false;
    };
  }, [d.id, d.session_id]);

  if (!c || (c.runs.length < 2 && (c.choices?.length ?? 0) < 2)) return null;

  const edit = () => {
    const now: Record<number, number> = {};
    for (const r of c.choices ?? []) now[r.session_id] = OUT;
    for (const r of c.runs) now[r.session_id] = r.group;
    setDraft(now);
    setError(null);
  };

  const save = async (runs: { session_id: number; group: number }[]) => {
    setBusy(true);
    setError(null);
    try {
      setC({ ...(await api.setDebriefRuns(d.id, runs)), choices: c.choices });
      setDraft(null);
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const picked = draft ? Object.entries(draft).filter(([, g]) => g !== OUT) : [];
  const groups = c.runs.map((r) => r.group);
  const oneSetup = new Set(groups).size < 2;

  return (
    <View style={styles.box}>
      <View style={styles.links}>
        <Text style={t.body}>{coversLine(c)}</Text>
        <TextLink label={draft ? 'Keep as it is' : 'Change stints'} onPress={() => (draft ? setDraft(null) : edit())}
          disabled={busy} />
      </View>
      {!draft && oneSetup && c.runs.length > 1 && !c.set_by_user && (
        <Text style={t.note}>Changed the setup between stints? Mark it under Change stints, so each setup is checked against its own laps.</Text>
      )}
      {draft && (
        <View style={styles.editor}>
          <Text style={t.note}>Pick the setup each stint ran. Stints on the same setup are checked together.</Text>
          {(c.choices ?? []).map((r) => {
            const own = r.session_id === d.session_id;
            return (
              <Tabs key={r.session_id} label={own ? `${r.name} (this debrief's run)` : r.name}
                value={draft[r.session_id] ?? OUT}
                onChange={(g) => setDraft({ ...draft, [r.session_id]: g })}
                items={[
                  ...(own ? [] : [{ key: OUT, label: 'Left out', disabled: busy }]),
                  ...[0, 1, 2].map((g) => ({ key: g, label: `Setup ${g + 1}`, disabled: busy })),
                ]} />
            );
          })}
          {picked.length > MOST && <Text style={t.error}>{`Pick up to ${MOST} stints.`}</Text>}
          <View style={styles.links}>
            <TextLink label="Save" onPress={() => save(picked.map(([sid, g]) => ({ session_id: Number(sid), group: g })))}
              disabled={busy || picked.length > MOST} />
            {c.set_by_user && <TextLink label="Go back to the worked-out stints" onPress={() => save([])} disabled={busy} />}
          </View>
        </View>
      )}
      {error && <Text style={t.error}>{error}</Text>}
    </View>
  );
}

const useStyles = themed(() => ({
  box: { marginTop: 12, gap: 12 },
  editor: { gap: 16 },
  links: StyleSheet.flatten({ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 24, rowGap: 8 }),
}));
