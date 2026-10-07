// One line on the report while its figures wait for the server: waking up (it sleeps after 15 min idle), busy, or
// still working a figure out. The figures ask again by themselves (lib/retry.ts) and appear when they're ready.
import { useEffect, useState } from 'react';

import { Text } from '@/components/Themed';
import { themed, Type } from '@/constants/Theme';
import { Palette } from '@/constants/Colors';
import { onReadsChange, readsNow } from '@/lib/retry';

const SLOW_MS = 8_000; // a figure taking longer than this is being worked out now, not read from what is kept

export function ServerNote() {
  const styles = useStyles();
  const [, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    const off = onReadsChange(again);
    const timer = setInterval(() => readsNow().oldest != null && again(), 1000); // to pass SLOW_MS without a change
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);
  const { waking, busy, oldest } = readsNow();
  const text = waking ? 'Waking the server… the figures appear by themselves in a moment.'
    : busy || (oldest != null && Date.now() - oldest > SLOW_MS)
      ? 'Still working some figures out… they appear by themselves when ready.'
      : null;
  return text ? <Text style={styles.note} accessibilityLiveRegion="polite">{text}</Text> : null;
}

const useStyles = themed((c: Palette) => ({
  note: { ...Type.dek, fontSize: 15, lineHeight: 21, color: c.textSecondary, marginTop: 6 },
}));
