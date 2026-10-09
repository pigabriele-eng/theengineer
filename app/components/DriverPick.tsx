// "Driver?" a tap to set wherever a run shows it, not only on the event page's run rows (Gabriele, 2026-10-09: "it
// shows Driver? but it's not clickable and i cannot select a driver"): under an upload's tyres for each stint
// (components/TyrePicks.tsx) and on the Laps tab's runs and laps (components/weekend/Laps.tsx). The tag opens the
// run's driver list right under its line, the event page's own (RunPicker: the event's drivers first, then the
// garage's, or a new name), and the pick is saved at once, as on the run rows.
import { ReactNode, useState } from 'react';
import { ViewStyle } from 'react-native';

import { Said } from '@/components/Controls';
import { RunPicker, RunRef, filledNote, useEventDrivers, useGarage } from '@/components/RunChips';
import { View } from '@/components/Themed';
import { garageApi, RunFields } from '@/lib/garage';

export type DriverPick = {
  /** The run's driver: the one picked here, else the one the page read. */
  name: (id: number, read: string | null) => string | null;
  /** Open or close the run's driver list. */
  toggle: (id: number) => void;
  /** Under the run's line: its driver list while open, then what the pick did or why it wasn't saved. */
  panel: (run: RunRef, style?: ViewStyle) => ReactNode;
};

/** The driver lists of an event's runs, one open at a time. `onPicked`: a driver was saved (read the runs again). */
export function useDriverPick(eventId: number | null | undefined, onPicked?: () => void): DriverPick {
  const { garage, reload } = useGarage();
  const eventDrivers = useEventDrivers(eventId);
  const [open, setOpen] = useState<number | null>(null);
  const [picked, setPicked] = useState<Record<number, string | null>>({});
  const [said, setSaid] = useState<{ id: number; text: string; error: boolean } | null>(null);

  const pick = async (run: RunRef, fields: RunFields) => {
    setOpen(null);
    setSaid(null);
    const before = picked;
    const local = garage?.drivers.find((d) => d.id === fields.driver_id)?.name ?? fields.driver_name ?? null;
    setPicked((p) => ({ ...p, [run.id]: local }));
    try {
      const r = await garageApi.setRun(run.id, fields);
      setPicked((p) => ({ ...p, [run.id]: r.driver }));
      const note = filledNote(r);
      if (note) setSaid({ id: run.id, text: note, error: false });
      reload();
      onPicked?.();
    } catch (e) {
      setPicked(before);
      setSaid({ id: run.id, text: `Not saved: ${(e as Error).message}`, error: true });
    }
  };

  return {
    name: (id, read) => (id in picked ? picked[id] : read),
    toggle: (id) => {
      setSaid(null);
      setOpen((o) => (o === id ? null : id));
    },
    panel: (run, style) => (
      <>
        {open === run.id && garage && (
          <View style={style}>
            <RunPicker run={{ ...run, driver: picked[run.id] ?? run.driver }} garage={garage}
              eventDrivers={eventDrivers} onPick={(fields) => pick(run, fields)} onClose={() => setOpen(null)} />
          </View>
        )}
        {said?.id === run.id && (
          <View style={style}>
            <Said text={said.text} error={said.error} onPress={() => setSaid(null)} />
          </View>
        )}
      </>
    ),
  };
}
