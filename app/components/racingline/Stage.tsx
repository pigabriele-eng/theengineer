// What the racing line page (app/racing-line.tsx) and its compact view on the weekend page
// (components/racingline/RacingLineView.tsx) share: the line asked for (useRacingLine) and the stage, the 3D view with
// its playback bar, the gesture hint and the legend, and beside it (from SIDE wide) or under it whatever the screen
// puts there (the page its numbers at the playhead, the compact view a few lines).
import { ReactNode, useEffect, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import { useText } from '@/components/Picks';
import { Text, View } from '@/components/Themed';
import { Legend } from '@/components/racingline/Legend';
import { PlaybackBar, PlaybackState } from '@/components/racingline/Playback';
import { Scene3D } from '@/components/racingline/Scene3D';
import { useScenePalette } from '@/components/racingline/colors';
import type { CameraMode } from '@/components/racingline/types';
import { themed, WIDE } from '@/constants/Theme';
import { fetchRacingLine, RacingLine } from '@/lib/racingLine';
import { encodeOthers, encodeTheoreticals, LapRef, TheoreticalSpec } from '@/lib/racingLineMath';

export const SIDE = 1000; // from this wide what the screen puts beside the 3D view stands beside it

/** The line for these laps (none: the server picks the session's two quickest clean laps) and the theoretical laps
 * beside them, asked for again `delay` ms after the laps last changed; the last answer kept meanwhile. */
export function useRacingLine(sessionId: number | null, laps: number[], others: LapRef[],
  theoreticals: TheoreticalSpec[], delay = 0) {
  const [data, setData] = useState<RacingLine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = `${sessionId}|${laps.join(',')}|${encodeOthers(others)}|${encodeTheoreticals(theoreticals)}`;
  useEffect(() => {
    if (sessionId == null) return;
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      fetchRacingLine(sessionId, laps, others, theoreticals).then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      }, (e) => {
        if (!live) return;
        setError((e as Error).message);
        setLoading(false);
      });
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- the laps, by value
  return { data, error, loading };
}

/** The 3D view, its playback bar, the hint and the legend; `aside` beside it from SIDE wide, else under it. Without
 * the line yet, the view alone with `waiting` under it: three.js and the renderer get ready while the line is on its
 * way, and the same view draws it when it comes. */
export function RacingLineStage({ data, p, colors, height, aside, asideWidth = 340, waiting }: {
  data: RacingLine | null;
  p: PlaybackState;
  colors: string[];
  height: number;
  aside?: ReactNode;
  asideWidth?: number;
  waiting?: ReactNode;
}) {
  const styles = useStyles();
  const t = useText();
  const palette = useScenePalette();
  const { width } = useWindowDimensions();
  // the bird view on a phone, where the tyres' loads read best; the chase camera on a computer
  const [camera, setCamera] = useState<CameraMode>(() => (width < WIDE ? 'bird' : 'chase'));
  const [trails, setTrails] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const side = width >= SIDE && aside != null;
  const label = data
    ? `3D view of ${data.laps.map((l) => l.label).join(', ')} on the track, at ${Math.round(p.m)} metres. The numbers beside it say the same.`
    : '3D view, waiting for the laps';
  return (
    <View style={side ? styles.stageSide : styles.stage}>
      <View style={side ? styles.view : undefined}>
        <Scene3D data={data} colors={colors} palette={palette} playhead={p.head} camera={camera} trails={trails}
          resetKey={resetKey} height={height} label={label} />
        {data ? (
          <>
            <PlaybackBar data={data} p={p} camera={camera} onCamera={setCamera}
              onResetView={() => setResetKey((k) => k + 1)} trails={trails} onTrails={setTrails} />
            {Platform.OS === 'web' && (
              <Text style={t.small}>Drag on the view to turn it, scroll or pinch to zoom, double-tap to put it back.</Text>
            )}
            <Legend data={data} colors={colors} />
          </>
        ) : waiting}
      </View>
      {data && aside != null && <View style={side ? { width: asideWidth, gap: 8 } : styles.aside}>{aside}</View>}
    </View>
  );
}

const useStyles = themed(() => ({
  stage: { gap: 14, paddingTop: 14 },
  stageSide: { flexDirection: 'row', gap: 20, paddingTop: 14, alignItems: 'flex-start' },
  view: { flex: 1, minWidth: 0, gap: 8 },
  aside: { gap: 8 },
}));
