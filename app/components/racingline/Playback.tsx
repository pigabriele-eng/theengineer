// The racing line's playback: the playhead going round the lap (at the first lap's own speed, times the rate picked),
// and its controls in the programme's look: Play/Pause, the rate, Same place / Real time, the camera, the previous
// and next corner, and a scrub bar over the lap with the corner numbers under it. Every control is a 44 px tap target
// that says whether it is picked (lib/a11yState.ts); the scrub bar is a slider the keyboard moves too.
import { useCallback, useEffect, useRef, useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Platform, Pressable, StyleSheet } from 'react-native';

import { Toggle } from '@/components/Picks';
import { Text, View } from '@/components/Themed';
import type { CameraMode, Playhead } from '@/components/racingline/types';
import { Fonts, TAP, themed, Type } from '@/constants/Theme';
import { a11yState } from '@/lib/a11yState';
import type { RacingLine } from '@/lib/racingLine';
import { advance, apexes, cornerJump, LEAD_M, placeCount, Sync } from '@/lib/racingLineMath';

export const RATES = [0.25, 0.5, 1, 2];
const SHOWN_MS = 100; // the numbers beside the view follow the playhead ten times a second

/** The playhead: in a ref the 3D view reads every frame, and as state (ten times a second) for the numbers. */
export function usePlayback(data: RacingLine | null) {
  const head: Playhead = useRef({ m: 0, sync: 'place' as Sync });
  const [m, setM] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(0.5);
  const [sync, setSyncState] = useState<Sync>('place');
  const lap = useRef<RacingLine | null>(null);
  lap.current = data;
  const end = data ? (placeCount(data) - 1) * data.step_m : 0;

  // a new lap set: the playhead before the first corner
  const key = data ? `${data.session_id}|${data.laps.map((l) => l.key).join(',')}|${data.length_m}` : '';
  useEffect(() => {
    if (!data) return;
    const first = apexes(data)[0];
    const start = first ? Math.max(0, first.apex_m - LEAD_M) : 0;
    head.current.m = Math.min(start, end);
    setM(head.current.m);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = Date.now();
    let shown = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = Date.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const d = lap.current;
      if (!d || !d.laps.length) return;
      head.current.m = advance(d, head.current.m, dt, rate);
      if (now - shown >= SHOWN_MS) {
        shown = now;
        setM(head.current.m);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      setM(head.current.m);
    };
  }, [playing, rate]);

  const seek = useCallback((to: number) => {
    head.current.m = Math.max(0, Math.min(end, to));
    setM(head.current.m);
  }, [end]);
  const setSync = useCallback((s: Sync) => {
    head.current.sync = s;
    setSyncState(s);
  }, []);
  const jump = useCallback((dir: 1 | -1) => {
    if (lap.current) seek(cornerJump(lap.current, head.current.m, dir));
  }, [seek]);
  return { head, m, seek, playing, setPlaying, rate, setRate, sync, setSync, jump, end };
}

export type PlaybackState = ReturnType<typeof usePlayback>;

/** A row of words to pick one of, the picked one in ink over a red underline. */
export function Seg<K extends string | number>({ label, items, value, onChange }: {
  label: string;
  items: { key: K; label: string; hint?: string }[];
  value: K;
  onChange: (k: K) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.seg}>
      <Text style={styles.segLabel}>{label}</Text>
      <View style={styles.segRow}>
        {items.map((it) => {
          const on = it.key === value;
          return (
            <Pressable key={String(it.key)} onPress={() => onChange(it.key)} accessibilityRole="button"
              accessibilityLabel={`${label}: ${it.label}`} accessibilityHint={it.hint}
              {...a11yState({ selected: on }, 'button')} style={styles.segHit}>
              <View style={StyleSheet.flatten([styles.segItem, on && styles.segOn])}>
                <Text style={StyleSheet.flatten([styles.segText, on && styles.segTextOn])}>{it.label}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** A square button: Archivo capitals in an ink outline (`solid`: paper on ink). */
export function Btn({ label, onPress, solid, a11y }: { label: string; onPress: () => void; solid?: boolean;
  a11y?: string }) {
  const styles = useStyles();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y ?? label}
      style={StyleSheet.flatten([styles.btn, solid && styles.btnSolid])}>
      <Text style={StyleSheet.flatten([styles.btnText, solid && styles.btnTextSolid])}>{label}</Text>
    </Pressable>
  );
}

/** The scrub bar: a tap or a drag puts the playhead there; on the web the arrow keys move it 10 m (Page Up and Down,
 * 100 m). The corner numbers sit under it at their apexes. */
export function Scrub({ data, m, end, onSeek }: { data: RacingLine; m: number; end: number;
  onSeek: (m: number) => void }) {
  const styles = useStyles();
  const [w, setW] = useState(0);
  const at = (e: GestureResponderEvent) => {
    if (w > 0) onSeek((Math.max(0, Math.min(w, e.nativeEvent.locationX)) / w) * end);
  };
  const share = end > 0 ? m / end : 0;
  const corners = apexes(data);
  let lastX = -Infinity;
  const labels = w > 0 ? corners.filter((c) => {
    const x = (c.apex_m / end) * w;
    if (x - lastX < 30) return false;
    lastX = x;
    return true;
  }) : [];
  const keys = Platform.OS === 'web' ? {
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      const step = e.key === 'PageUp' || e.key === 'PageDown' ? 100 : 10;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'PageUp') onSeek(m + step);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'PageDown') onSeek(m - step);
      else if (e.key === 'Home') onSeek(0);
      else if (e.key === 'End') onSeek(end);
      else return;
      e.preventDefault();
    },
  } : {};
  return (
    <View style={styles.scrubWrap}>
      <View
        style={styles.scrub}
        onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={at}
        onResponderMove={at}
        accessible
        focusable
        accessibilityRole="adjustable"
        accessibilityLabel="Place on the lap"
        aria-valuemin={0}
        aria-valuemax={Math.round(end)}
        aria-valuenow={Math.round(m)}
        aria-valuetext={`${Math.round(m)} m of ${Math.round(end)} m`}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => onSeek(m + (e.nativeEvent.actionName === 'increment' ? 25 : -25))}
        {...(keys as object)}
      >
        <View style={styles.track} pointerEvents="none">
          <View style={StyleSheet.flatten([styles.fill, { width: `${share * 100}%` }])} />
        </View>
        {corners.map((c) => (
          <View key={c.code} pointerEvents="none"
            style={StyleSheet.flatten([styles.tick, { left: w * (c.apex_m / (end || 1)) }])} />
        ))}
        <View pointerEvents="none" style={StyleSheet.flatten([styles.thumb, { left: Math.max(0, w * share - 7) }])} />
      </View>
      <View style={styles.codes} pointerEvents="none" importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden>
        {labels.map((c) => (
          <Text key={c.code} style={StyleSheet.flatten([styles.code, { left: (c.apex_m / end) * w - 20 }])}>{c.code}</Text>
        ))}
      </View>
    </View>
  );
}

/** Everything that drives the view, in one block under it. */
export function PlaybackBar({ data, p, camera, onCamera, onResetView, trails, onTrails }: {
  data: RacingLine;
  p: PlaybackState;
  camera: CameraMode;
  onCamera: (c: CameraMode) => void;
  onResetView: () => void;
  trails: boolean;
  onTrails: (on: boolean) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.bar}>
      <View style={styles.row}>
        <Btn solid label={p.playing ? 'Pause' : 'Play'} onPress={() => p.setPlaying(!p.playing)} />
        <Btn label="← Corner" a11y="Previous corner" onPress={() => p.jump(-1)} />
        <Btn label="Corner →" a11y="Next corner" onPress={() => p.jump(1)} />
        <Text style={styles.at} accessibilityLiveRegion="none">{`${Math.round(p.m).toLocaleString('en-GB')} m`}</Text>
      </View>
      <Scrub data={data} m={p.m} end={p.end} onSeek={p.seek} />
      <View style={styles.row}>
        <Seg label="Compare" value={p.sync} onChange={p.setSync}
          items={[{ key: 'place', label: 'Same place', hint: 'Every car at the same metre: best to compare lines' },
            { key: 'time', label: 'Real time', hint: 'Each car where it was at the same clock time' }]} />
        <Seg label="Speed" value={p.rate} onChange={p.setRate}
          items={RATES.map((r) => ({ key: r, label: `${r}×` }))} />
      </View>
      <View style={styles.row}>
        <Seg label="Camera" value={camera} onChange={onCamera}
          items={[{ key: 'chase', label: 'Chase', hint: 'Behind and above the first lap’s car' },
            { key: 'above', label: 'Above', hint: 'High behind the first car, looking down the road' },
            { key: 'trackside', label: 'Trackside', hint: 'Fixed beside the corner the first car is in' },
            { key: 'bird', label: 'Bird view', hint: 'Straight down over the first car: its tyre loads and where the load sits' }]} />
        <Btn label="Reset view" onPress={onResetView} />
      </View>
      <View style={styles.toggle}>
        <Toggle on={trails} onChange={onTrails} label="Load trails"
          detail="Each tyre’s load painted on the tarmac where that tyre ran, deeper and wider with more load" />
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  bar: { gap: 10, paddingTop: 10 },
  toggle: { paddingVertical: 4, maxWidth: 560 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', columnGap: 18, rowGap: 8 },
  at: { ...Type.number, fontSize: 16, color: c.text, minHeight: TAP, textAlignVertical: 'center', lineHeight: TAP },
  seg: { gap: 2 },
  segLabel: { ...Type.label, fontSize: 13, color: c.textMuted },
  segRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 4 },
  segHit: { minHeight: TAP, minWidth: TAP, justifyContent: 'center', paddingHorizontal: 6 },
  segItem: { paddingBottom: 3, borderBottomWidth: 3, borderColor: 'transparent' },
  segOn: { borderColor: c.mark },
  segText: { ...Type.label, fontSize: 14, letterSpacing: 1.2, color: c.textMuted },
  segTextOn: { color: c.text },
  btn: { minHeight: TAP, minWidth: TAP, paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: c.borderStrong },
  btnSolid: { backgroundColor: c.tint, borderColor: c.tint },
  btnText: { ...Type.link, fontSize: 14, color: c.text },
  btnTextSolid: { color: c.onTint },
  scrubWrap: { gap: 2 },
  scrub: { height: TAP, justifyContent: 'center' },
  track: { height: 6, backgroundColor: c.fill },
  fill: { height: 6, backgroundColor: c.tint },
  tick: { position: 'absolute', top: 12, width: 1, height: 20, backgroundColor: c.textMuted },
  thumb: { position: 'absolute', top: 8, width: 14, height: 28, backgroundColor: c.mark, borderWidth: 2,
    borderColor: c.background },
  codes: { height: 18 },
  code: { position: 'absolute', width: 40, textAlign: 'center', fontFamily: Fonts.label, fontSize: 13, color: c.textSecondary },
}));
