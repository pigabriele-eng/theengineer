// A lap's type set by hand (Gabriele, 2026-10-09: "add the ability to manually change the nature of the lap in case
// the app gets it wrong"): one tap on a lap's type opens this menu, like a run row's hold menu
// (components/RunActions.tsx): the lap and Close over a rule, then Out lap, Build lap, Push lap and In lap, each a full
// line to tap, and "Let the app read it" once it was set by hand. The pick wins on every page and stays when the log
// is timed again (PUT /sessions/{id}/laps/{n}/type).
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, View as RNView } from 'react-native';

import { Label } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { api, LapPick, SessionDetail } from '@/lib/api';
import { TAP, themed, Type, useTheme } from '@/constants/Theme';

export const LAP_PICKS: LapPick[] = ['out', 'build', 'push', 'in'];
export const LAP_TYPE: Record<LapPick, string> = { out: 'Out lap', build: 'Build lap', push: 'Push lap', in: 'In lap' };
const MEANS: Record<LapPick, string> = {
  out: 'not timed against the others',
  build: 'kept, left out of the repeats',
  push: 'judged with the clean laps',
  in: 'not timed against the others',
};

const web = Platform.OS === 'web';

/** Which lap's menu is open, and setting the type: `pick` sends it and hands the run back as it is now. */
export function useLapType(session: number | null, fileId: number | undefined, onDone: (s: SessionDetail) => void) {
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (lap: number, type: LapPick | null) => {
    if (session == null) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.setLapType(session, lap, type, fileId);
      setOpen(null);
      onDone(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return {
    open, busy, error, pick,
    toggle: (lap: number) => {
      setError(null);
      setOpen((cur) => (cur === lap ? null : lap));
    },
    close: () => setOpen(null),
  };
}
export type LapTypeState = ReturnType<typeof useLapType>;

/** The menu under a lap: `now` is how the lap reads now, `picked` whether that was set by hand. */
export function LapTypeMenu({ lap, now, picked, state, focus }: {
  lap: number;
  now: string; // "an out lap", "a clean lap": how the lap reads now, in words
  picked: LapPick | null;
  state: LapTypeState;
  focus?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  const first = useRef<RNView>(null);
  useEffect(() => {
    if (web && focus) (first.current as unknown as HTMLElement | null)?.focus?.();
  }, [focus]);
  const keys = web ? { onKeyDown: (e: { key?: string }) => e.key === 'Escape' && state.close() } : null;
  const lines: { key: LapPick | null; words: string; sub: string }[] = [
    ...LAP_PICKS.map((k) => ({ key: k, words: LAP_TYPE[k], sub: MEANS[k] })),
    ...(picked ? [{ key: null, words: 'Let the app read it', sub: 'as it was timed' }] : []),
  ];
  return (
    <View style={styles.menu} {...keys}>
      <View style={styles.head}>
        <View style={styles.name}>
          <Label>{`Lap ${lap}`}</Label>
          <Text style={styles.now}>{`Now ${now}${picked ? ', as you set it' : ', as the app reads it'}`}</Text>
        </View>
        {state.busy && <ActivityIndicator size="small" color={c.text} />}
        <Pressable onPress={state.close} accessibilityRole="button" accessibilityLabel={`Close the lap type of lap ${lap}`}
          style={styles.close}>
          <Text style={styles.closeText}>Close</Text>
        </Pressable>
      </View>
      {lines.map((l, i) => {
        const on = l.key != null && l.key === picked;
        return (
          <Pressable key={l.key ?? 'app'} ref={i === 0 ? first : undefined} disabled={state.busy}
            onPress={() => state.pick(lap, l.key)} accessibilityRole="button"
            accessibilityLabel={`Lap ${lap}: ${l.key ? `${l.words}, ${l.sub}` : l.words}${on ? ', set now' : ''}`}
            style={i < lines.length - 1 ? styles.item : styles.last}>
            <Text style={styles.text}>{on ? `${l.words}  ✓` : l.words}</Text>
            <Text style={styles.sub}>{l.sub}</Text>
          </Pressable>
        );
      })}
      {state.error && <Text style={styles.error}>{state.error}</Text>}
    </View>
  );
}

/** How a lap reads now, in words for the menu's head. */
export function lapTypeWords(picked: LapPick | null | undefined, status: string): string {
  if (picked) return `a${picked === 'out' || picked === 'in' ? 'n' : ''} ${LAP_TYPE[picked].toLowerCase()}`;
  const words: Record<string, string> = {
    fastest: 'the quickest clean lap', clean: 'a clean lap', out: 'an out lap', in: 'an in lap', pit: 'a pit lap',
    slow: 'a slow lap', build: 'a build lap', other: 'a lap that isn’t clean',
  };
  return words[status] ?? 'a lap';
}

const useStyles = themed((c) => ({
  menu: { borderTopWidth: 3, borderColor: c.rule, maxWidth: 420, marginTop: 4, marginBottom: 8,
    backgroundColor: c.background },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: c.rule },
  name: { flex: 1, paddingVertical: 6 },
  now: { fontSize: 16, lineHeight: 22, color: c.textSecondary },
  close: { minHeight: TAP, minWidth: TAP, alignItems: 'flex-end', justifyContent: 'center' },
  closeText: { ...Type.link, fontSize: 16, color: c.textSecondary },
  item: { minHeight: TAP + 4, justifyContent: 'center', paddingVertical: 6, borderBottomWidth: 1, borderColor: c.separator },
  last: { minHeight: TAP + 4, justifyContent: 'center', paddingVertical: 6 },
  text: { ...Type.link, fontSize: 16, color: c.text },
  sub: { fontSize: 16, lineHeight: 22, color: c.textSecondary },
  error: { fontSize: 16, lineHeight: 22, color: c.error, paddingVertical: 6 },
}));
