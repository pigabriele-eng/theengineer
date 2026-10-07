// For the vehicle model: pick a run with a setup sheet and load its setup (bars, spring rates, fuel and ballast,
// ride heights) on top of the vehicle picked (its specs), else the car's preset. The runs are the programme's
// options (capitals, the one loaded over a red underline), under a ruled sub-head.
import { useEffect, useState } from 'react';

import { Text, View } from '@/components/Themed';
import { ErrorLine, Note, Options, SubHead, Working } from '@/components/ToolForm';
import { SetupListItem, setupApi, SetupVehicle } from '@/lib/setup';
import { Vehicle } from '@/lib/vehicle';
import { Fonts, themed } from '@/constants/Theme';

export function SetupLoader({
  initial,
  ready,
  vehicleId,
  onLoad,
}: {
  initial?: number; // a session to load straight away (from ?session=)
  ready: boolean; // the preset is in the form, so a loaded setup isn't overwritten by it
  vehicleId?: number | null; // the garage vehicle the setup goes on top of (else the session's)
  onLoad: (v: Vehicle) => void;
}) {
  const styles = useStyles();
  const [runs, setRuns] = useState<SetupListItem[]>([]);
  const [loaded, setLoaded] = useState<SetupVehicle | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setupApi.withSheets().then(setRuns, () => {});
  }, []);

  const load = async (id: number) => {
    setBusy(id);
    setError(null);
    try {
      const v = await setupApi.vehicle(id, vehicleId);
      setLoaded(v);
      onLoad(v.vehicle);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (ready && initial != null) load(initial);
    // only once the preset is in, and only for the session the screen was opened with
  }, [ready, initial]);

  if (!runs.length && initial == null) return null;
  const busyName = busy != null ? runs.find((r) => r.session_id === busy)?.name ?? `session ${busy}` : null;
  return (
    <View>
      <SubHead>Load a run’s setup</SubHead>
      <Options label="Run with a setup sheet" value={loaded?.session_id ?? null} disabled={!ready || busy != null}
        onPick={load} options={runs.map((r) => ({ value: r.session_id, label: r.name ?? `Session ${r.session_id}` }))} />
      {busyName ? <Working>Loading {busyName}…</Working> : null}
      {error ? <View style={styles.gap}><ErrorLine>{error}</ErrorLine></View> : null}
      {loaded && (
        <View style={styles.loaded}>
          <Text style={styles.applied}>
            <Text style={styles.name}>{loaded.name ?? 'This run'}: </Text>
            {loaded.applied.map((a) => a.from).join(' · ') || 'nothing the model uses'}
          </Text>
          {loaded.notes.map((n) => <Note key={n} small>{n}</Note>)}
        </View>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  gap: { marginTop: 10 },
  loaded: { marginTop: 14, gap: 4, borderTopWidth: 1, borderColor: c.separator, paddingTop: 10 },
  applied: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: c.text },
  name: { fontFamily: Fonts.label, fontSize: 15, color: c.text },
}));
