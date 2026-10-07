import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { EventGuess, fingerprintsApi, guessLine, RunGuess } from '@/lib/fingerprints';
import { RunFields } from '@/lib/garage';
import { face, themed } from '@/constants/Theme';

const POLL_MS = 4000;

/** Who drove each run of the event by driving style: asked once `version` is there (the event's runs: not before,
 * so a visit asks once), again whenever it changes (a driver tagged, a run added) and while the event's laps are
 * still being read. */
export function useDriverGuess(eventId: number | null, version: unknown) {
  const [guess, setGuess] = useState<EventGuess | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(() => {
    if (eventId == null) return;
    fingerprintsApi.event(eventId).then(
      (g) => {
        setGuess(g);
        if (timer.current) clearTimeout(timer.current);
        if (g.status === 'working') timer.current = setTimeout(load, POLL_MS);
      },
      () => setGuess(null), // an older server, or no laps: the runs simply show no suggestion
    );
  }, [eventId]);
  useEffect(() => {
    if (version == null) return;
    load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, version]);
  return guess;
}

/** The line under a run's driver chip: who the driving style says drove it, with a tap to confirm, the driver change
 * inside the run, or that the style set the driver by itself (sure of it), with a tap to change it. */
export function DriverGuessLine({ guess, mode, onPick, onName }: {
  guess: RunGuess | undefined;
  mode: EventGuess['mode'] | undefined;
  onPick: (fields: RunFields) => void;
  onName: () => void; // open the driver list (a style with no driver named yet)
}) {
  const styles = useStyles();
  const line = guessLine(guess, mode);
  if (!guess || !line) return null;
  const s = guess.suggestion;
  const action = guess.auto && guess.driver_id != null ? { label: 'Change', onPress: onName }
    : guess.stints.length > 1 ? null
    : s.driver_id != null && guess.driver_id !== s.driver_id
      ? { label: guess.driver_id == null ? 'Confirm' : `Change to ${s.driver}`, onPress: () => onPick({ driver_id: s.driver_id }) }
      : guess.driver_id == null ? { label: 'Name this driver', onPress: onName } : null;
  return (
    <View style={styles.line}>
      <Text style={styles.text}>{line}</Text>
      {action && (
        <Pressable onPress={action.onPress} hitSlop={6} accessibilityRole="button" style={styles.act}>
          <Text style={styles.actText}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 10, rowGap: 2, marginTop: 4 },
  text: { fontFamily: face('body', 400, true), fontSize: 14, lineHeight: 19, color: c.textMuted },
  act: StyleSheet.flatten({ borderBottomWidth: 2, borderColor: c.tint }),
  actText: { fontFamily: face('label', 700), fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', color: c.text },
}));
