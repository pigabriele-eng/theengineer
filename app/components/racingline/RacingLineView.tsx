// The racing line, compact, for a section of the weekend page (Gabriele, 2026-10-15: "quick 3d racing line
// comparison together with the theoreticals"): up to four real laps driven in 3D with the stint and combined
// theoretical laps as cars of their own (a hollow line and a wire car with its name over it, never like a real lap,
// each corner taken from the real lap holding it), the playback bar and the legend, the cars at the playhead in a
// few lines, then corner by corner which lap each theoretical drives there and what differs, in words. The full page
// (app/racing-line.tsx) opens on the same laps. No page chrome: the weekend page's section holds it.
import { useEffect, useMemo } from 'react';
import { ActivityIndicator, Pressable, useWindowDimensions } from 'react-native';

import { ErrorLine, Note } from '@/components/Controls';
import { Label, TextLink } from '@/components/Programme';
import { drivingWords } from '@/components/racingline/Hud';
import { LapKey } from '@/components/racingline/LapKey';
import { PlaybackState, usePlayback } from '@/components/racingline/Playback';
import { RacingLineStage, SIDE, useRacingLine } from '@/components/racingline/Stage';
import { useLineColors } from '@/components/racingline/colors';
import { Text, View } from '@/components/Themed';
import { Fonts, TAP, themed, Type } from '@/constants/Theme';
import type { RacingLine } from '@/lib/racingLine';
import {
  encodeTheoreticals, LEAD_M, MAX_RL_THEORETICALS, parseLaps, parseOthers, placesAt, racingLineParams, sample,
  sectionAt, TheoreticalSpec,
} from '@/lib/racingLineMath';

export type RacingLineViewProps = {
  laps: { session_id: number; lap: number }[]; // real laps, up to four (more are left out); the first leads
  corner?: string; // 'T3' (or a section's 'T6-T7'): the playhead, and the camera with it, jump there
  theoreticals?: TheoreticalSpec[]; // lib/theoretical.ts stitchSpecs(answer): driven beside the real laps
};

/** The weekend page's racing line: the 3D view of these laps and theoretical laps, compact. */
export function RacingLineView({ laps, corner, theoreticals }: RacingLineViewProps) {
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const params = racingLineParams(laps);
  const sessionId = params ? Number(params.session) : null;
  const own = useMemo(() => parseLaps(params?.laps), [params?.laps]);
  const others = useMemo(() => parseOthers(params?.others), [params?.others]);
  const theo = useMemo(() => (theoreticals ?? []).slice(0, MAX_RL_THEORETICALS), [theoreticals]);
  const { data, error, loading } = useRacingLine(sessionId, own, others, theo);
  const colors = useLineColors(data);
  const p = usePlayback(data);

  // the corner asked for: the playhead a little before its apex, the camera following the first car there
  useEffect(() => {
    if (!data || !corner) return;
    const at = data.corners.find((c) => c.code === corner) ?? data.sections.find((s) => s.code === corner)
      ?? data.sections.find((s) => s.code.split('-').includes(corner));
    if (at) p.seek(Math.max(0, at.apex_m - LEAD_M));
  }, [data, corner]); // eslint-disable-line react-hooks/exhaustive-deps -- the seek follows the answer

  if (!params) return <Note>Pick a lap to see its line in 3D.</Note>;
  const full = { pathname: '/racing-line' as const,
    params: { ...params, ...(theo.length ? { theo: encodeTheoreticals(theo) } : {}) } };
  const link = <TextLink href={full} label="Open the full racing line page" arrow />;
  if (error) {
    return (
      <View style={styles.box}>
        <ErrorLine>{`The racing line couldn’t be read: ${error}`}</ErrorLine>
        {link}
      </View>
    );
  }
  const side = width >= SIDE;
  const height = side ? 460 : Math.round(Math.min(380, Math.max(280, width * 0.8)));
  const busy = (words: string) => (
    <View style={styles.waiting} accessibilityLiveRegion="polite">
      <ActivityIndicator />
      <Note>{words}</Note>
    </View>
  );
  // the 3D view from the start (three.js and its renderer get ready while the line is worked out), the laps on it
  // once they come
  return (
    <View style={styles.box}>
      {data && loading && busy('Placing the laps again…')}
      {data?.notes?.map((n) => <Note key={n}>{n}</Note>)}
      <RacingLineStage data={data} p={p} colors={colors} height={height} asideWidth={320}
        aside={data ? <AtPlayhead data={data} colors={colors} p={p} /> : null}
        waiting={busy('Placing the laps on the track…')} />
      {data && <CornerNotes data={data} colors={colors} onSeek={p.seek} />}
      {link}
    </View>
  );
}

/** Each car at the playhead in a line: its speed and gear, how far behind or ahead of the first, and for a theoretical
 * lap the real lap it is driving there. */
function AtPlayhead({ data, colors, p }: { data: RacingLine; colors: string[]; p: PlaybackState }) {
  const styles = useStyles();
  const places = placesAt(data, p.m, p.sync);
  const here = sectionAt(data.sections, p.m);
  const first = data.laps[0];
  return (
    <View style={styles.now}>
      <Label small>{`At ${Math.round(p.m).toLocaleString('en-GB')} m${here ? ` · ${here.code}` : ''} · ${
        p.sync === 'place' ? 'same place' : 'real time'}`}</Label>
      {data.laps.map((l, k) => {
        const f = places[k] ?? 0;
        const dt = sample(l.t, f) - sample(first.t, places[0] ?? 0);
        const gap = k === 0 ? 'first' : p.sync === 'place'
          ? `${dt >= 0 ? '+' : '−'}${Math.abs(dt).toFixed(2)} s here`
          : `${Math.abs((f - (places[0] ?? 0)) * data.step_m).toFixed(0)} m ${f < (places[0] ?? 0) ? 'behind' : 'ahead'}`;
        return (
          <View key={l.key} style={styles.nowRow}>
            <View style={styles.nowHead}>
              <LapKey k={k} color={colors[k % colors.length]} width={26} theory={l.theoretical} />
              <Text style={styles.nowName}>{l.label}</Text>
            </View>
            <Text style={styles.nowText}>
              {`${Math.round(sample(l.speed, f))} km/h, gear ${Math.round(sample(l.gear, f))}, ${gap}`}
            </Text>
            {l.theoretical && <Text style={styles.nowText}>{drivingWords(l, data, f * data.step_m)}</Text>}
          </View>
        );
      })}
    </View>
  );
}

/** Corner by corner: the lap each theoretical drives there (and its driver), then what differs from the first lap,
 * in the server's words; a tap on the corner moves the 3D view there. */
function CornerNotes({ data, colors, onSeek }: { data: RacingLine; colors: string[]; onSeek: (m: number) => void }) {
  const styles = useStyles();
  if (!data.sections.length) return null;
  const theo = data.laps.map((l, k) => ({ l, k })).filter(({ l }) => l.theoretical);
  return (
    <View style={styles.notes}>
      <Label small>{`Corner by corner, against ${data.laps[0].label}`}</Label>
      {data.sections.map((s) => {
        const diffs = data.differences.filter((d) => d.code === s.code);
        return (
          <View key={s.code} style={styles.corner}>
            <Pressable onPress={() => onSeek(Math.max(0, s.apex_m - LEAD_M))} accessibilityRole="button"
              accessibilityLabel={`${s.code}: show it in the 3D view`} style={styles.codeHit}>
              <Text style={styles.code}>{s.code}</Text>
              <Text style={styles.codeNote}>Show in 3D →</Text>
            </Pressable>
            <View style={styles.lines}>
              {theo.map(({ l, k }) => {
                const h = l.from?.find((f) => f.code === s.code);
                return h ? (
                  <View key={l.key} style={styles.holder}>
                    <LapKey k={k} color={colors[k % colors.length]} width={22} theory={l.theoretical} />
                    <Text style={styles.text}>
                      <Text style={styles.strong}>{`${l.label}: `}</Text>
                      {`${h.label}${h.driver ? `, ${h.driver}` : ''}`}
                    </Text>
                  </View>
                ) : null;
              })}
              {diffs.map((d) => <Text key={d.lap} style={styles.text}>{d.words}</Text>)}
              {!diffs.length && !theo.length && <Text style={styles.muted}>No difference worth telling.</Text>}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { gap: 12 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: TAP },
  now: { gap: 6 },
  nowRow: { gap: 2, borderTopWidth: 1, borderColor: c.separator, paddingTop: 6 },
  nowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nowName: { ...Type.label, fontSize: 14, color: c.text, flexShrink: 1 },
  nowText: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.text },
  notes: { gap: 0, paddingTop: 6 },
  corner: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, borderTopWidth: 1, borderColor: c.rule,
    paddingVertical: 8 },
  codeHit: { minHeight: TAP, minWidth: 96, justifyContent: 'center', alignItems: 'flex-start' },
  code: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 28, color: c.text },
  codeNote: { ...Type.link, fontSize: 13, color: c.text },
  lines: { flex: 1, minWidth: 240, gap: 4, justifyContent: 'center' },
  holder: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  text: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text, flexShrink: 1 },
  strong: { fontFamily: Fonts.label, color: c.text },
  muted: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.textSecondary },
}));
