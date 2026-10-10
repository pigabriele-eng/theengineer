import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, useWindowDimensions } from 'react-native';

import { useBackTo } from '@/components/Back';
import { Choice, Notice, PageHead, useText } from '@/components/Picks';
import { Colophon, Label, Page, Section, TextLink, useWide } from '@/components/Programme';
import { CornerTable } from '@/components/racingline/CornerTable';
import { Hud } from '@/components/racingline/Hud';
import { Legend } from '@/components/racingline/Legend';
import { LineDiffChart } from '@/components/racingline/LineDiffChart';
import { PlaybackBar, usePlayback } from '@/components/racingline/Playback';
import { Scene3D } from '@/components/racingline/Scene3D';
import { useLapColors, useScenePalette } from '@/components/racingline/colors';
import type { CameraMode } from '@/components/racingline/types';
import { SessionSwitcher, useEventFolder } from '@/components/SessionSwitcher';
import { Text, View } from '@/components/Themed';
import { api, formatLap, Lap, SessionDetail } from '@/lib/api';
import { fetchRacingLine, RacingLine } from '@/lib/racingLine';
import {
  encodeOthers, LapRef, MAX_RL_LAPS, parseLaps, parseOthers, placesAt,
} from '@/lib/racingLineMath';
import { Fonts, inkOn, legibleFill, themed, Type, useTheme, WIDE } from '@/constants/Theme';

const SIDE = 1000; // from this wide the numbers stand beside the 3D view
type Picks = { laps: number[]; others: LapRef[] };

/** The laps of a run's main log, one per number, in lap order. */
function lapsOf(s: SessionDetail | null): Lap[] {
  if (!s?.laps.length) return [];
  const file = s.laps[0].file_id;
  return s.laps.filter((l) => l.file_id === file).sort((a, b) => a.number - b.number);
}

/** The racing line: up to four laps (the session's against each other, laps of the event's other sessions as an add)
 * driven again in 3D from the GPS and the steering, side by side on the tarmac they used, with where each brakes,
 * turns in, meets the apex and picks up the throttle, the car's attitude and where its load is; the numbers at the
 * playhead beside it, then each lap's line against the first's round the lap, and corner by corner what differs.
 * ?session=ID&laps=7,12&others=SID:N. */
export default function RacingLineScreen() {
  const t = useText();
  const styles = useStyles();
  const theme = useTheme();
  const wide = useWide();
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const params = useLocalSearchParams<{ session?: string; laps?: string; others?: string }>();
  const sessionId = params.session ? Number(params.session) : null;
  const [picks, setPicks] = useState<Picks | null>(() => {
    const laps = parseLaps(params.laps), others = parseOthers(params.others);
    return laps.length || others.length ? { laps, others } : null; // none: the server picks the two quickest
  });
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [data, setData] = useState<RacingLine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // the bird view on a phone, where the tyres' loads read best; the chase camera on a computer
  const [camera, setCamera] = useState<CameraMode>(() => (width < WIDE ? 'bird' : 'chase'));
  const [trails, setTrails] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [otherId, setOtherId] = useState<number | null>(null);
  const [other, setOther] = useState<SessionDetail | null>(null);
  const colors = useLapColors();
  const palette = useScenePalette();
  const p = usePlayback(data);

  // the run: its laps to pick from and its event
  useEffect(() => {
    if (sessionId == null) return;
    let live = true;
    api.session(sessionId).then((s) => live && setSession(s), (e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [sessionId]);
  const eventId = (session as { event_id?: number | null } | null)?.event_id ?? null;
  const folder = useEventFolder(session ? eventId : undefined);
  useBackTo(eventId != null ? { id: eventId, name: folder?.id === eventId ? folder.name : null } : null);

  // the line itself, asked for again a moment after the laps picked last changed
  const pickKey = picks ? `${picks.laps.join(',')}|${encodeOthers(picks.others)}` : '';
  useEffect(() => {
    if (sessionId == null) return;
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      fetchRacingLine(sessionId, picks?.laps ?? [], picks?.others ?? []).then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      }, (e) => {
        if (!live) return;
        setError((e as Error).message);
        setLoading(false);
      });
    }, picks ? 350 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sessionId, pickKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // a lap of another session of the event, to add
  useEffect(() => {
    if (otherId == null) return;
    let live = true;
    setOther(null);
    api.session(otherId).then((s) => live && setOther(s), () => live && setOther(null));
    return () => {
      live = false;
    };
  }, [otherId]);

  // what is picked: as asked, else what the server picked
  const shown: Picks = useMemo(() => picks ?? {
    laps: data?.laps.filter((l) => l.session_id === sessionId).map((l) => l.number) ?? [],
    others: data?.laps.filter((l) => l.session_id !== sessionId).map((l) => ({ session: l.session_id, lap: l.number })) ?? [],
  }, [picks, data, sessionId]);
  const total = shown.laps.length + shown.others.length;
  const pick = (next: Picks) => {
    setPicks(next);
    router.setParams({ laps: next.laps.join(',') || undefined, others: encodeOthers(next.others) || undefined });
  };
  const toggleLap = (n: number) => {
    const on = shown.laps.includes(n);
    if (on && total > 1) pick({ ...shown, laps: shown.laps.filter((x) => x !== n) });
    else if (!on && total < MAX_RL_LAPS) pick({ ...shown, laps: [...shown.laps, n] });
  };
  const toggleOther = (r: LapRef) => {
    const on = shown.others.some((o) => o.session === r.session && o.lap === r.lap);
    if (on && total > 1) pick({ ...shown, others: shown.others.filter((o) => !(o.session === r.session && o.lap === r.lap)) });
    else if (!on && total < MAX_RL_LAPS) pick({ ...shown, others: [...shown.others, r] });
  };
  const colorOf = (sid: number, n: number) => {
    const k = data?.laps.findIndex((l) => l.session_id === sid && l.number === n) ?? -1;
    return k >= 0 ? colors[k % colors.length] : undefined;
  };

  if (sessionId == null) {
    return (
      <Page>
        <PageHead title="Racing line" dek="Open the racing line from a session." />
      </Page>
    );
  }

  const side = width >= SIDE;
  const places = data ? placesAt(data, p.m, p.sync) : [];
  const sceneHeight = side ? Math.round(Math.max(420, Math.min(660, height * 0.66)))
    : Math.round(Math.min(440, Math.max(280, width * 0.85)));
  const myLaps = lapsOf(session);
  const otherLaps = lapsOf(other);
  const title = session?.name ?? data?.session_name ?? `Session ${sessionId}`;
  const dek = [title, session?.track_name].filter(Boolean).join(' · ');
  const label = data
    ? `3D view of ${data.laps.map((l) => l.label).join(', ')} on the track, at ${Math.round(p.m)} metres. The numbers beside it say the same.`
    : '3D view';
  const lapChoice = (sid: number, l: Lap, on: boolean, onPress: () => void) => {
    const lapColor = on ? colorOf(sid, l.number) : undefined;
    const fill = lapColor ? legibleFill(lapColor) : undefined; // the time on it reads at 4.5:1
    return (
      <Choice key={`${sid}:${l.number}`} label={String(l.number)} detail={formatLap(l.time_s)} on={on}
        onPress={onPress} dim={!l.clean} fill={fill} ink={fill ? inkOn(fill) : undefined}
        disabled={!on && total >= MAX_RL_LAPS}
        accessibilityLabel={`Lap ${l.number}, ${formatLap(l.time_s)}${l.clean ? '' : ', not clean'}${on ? ', shown' : ''}`} />
    );
  };

  const stage = data && data.laps.length > 0 && (
    <View style={side ? styles.stageSide : styles.stage}>
      <View style={side ? styles.view : undefined}>
        <Scene3D data={data} colors={colors} palette={palette} playhead={p.head} camera={camera} trails={trails} resetKey={resetKey}
          height={sceneHeight} label={label} />
        <PlaybackBar data={data} p={p} camera={camera} onCamera={setCamera} onResetView={() => setResetKey((k) => k + 1)}
          trails={trails} onTrails={setTrails} />
        {Platform.OS === 'web' && (
          <Text style={t.small}>Drag on the view to turn it, scroll or pinch to zoom, double-tap to put it back.</Text>
        )}
        <Legend data={data} colors={colors} />
      </View>
      <View style={side ? styles.hudSide : styles.hud}>
        <Label small>{`At ${Math.round(p.m).toLocaleString('en-GB')} m · ${p.sync === 'place' ? 'same place' : 'real time'}`}</Label>
        <Hud data={data} colors={colors} places={places} sync={p.sync} columns={!side && wide ? 2 : 1} />
      </View>
    </View>
  );

  let no = 0;
  return (
    <Page>
      <Stack.Screen options={{ title: `Racing line · ${title}` }} />
      <PageHead title="Racing line" dek={dek || undefined} />
      {data && (
        <View style={styles.accuracy}>
          <Text style={t.body}>{data.accuracy.summary}</Text>
          {data.accuracy.within_session_m != null && (
            <Text style={styles.acc}>{`Good to about ±${data.accuracy.within_session_m.toFixed(1)} m within this session${
              data.accuracy.across_sessions_m != null ? `, ±${data.accuracy.across_sessions_m.toFixed(1)} m against another` : ''}`}</Text>
          )}
        </View>
      )}

      <View style={styles.pickers}>
        <View style={styles.lapHead}>
          <Label small>{`Laps of ${title}`}</Label>
          {loading && <ActivityIndicator size="small" color={theme.text} />}
        </View>
        <View style={styles.laps}>
          {myLaps.map((l) => lapChoice(sessionId, l, shown.laps.includes(l.number), () => toggleLap(l.number)))}
          {!myLaps.length && !error && <ActivityIndicator color={theme.text} />}
        </View>
        <Text style={t.note}>
          {`Up to ${MAX_RL_LAPS} laps. The first is the one the others are compared with`}
          {data?.laps[0] ? `: ${data.laps[0].label}.` : '.'}
          {' A picked lap wears its line’s colour.'}
        </Text>
        {shown.others.length > 0 && (
          <View style={styles.laps}>
            {shown.others.map((o) => {
              const l = data?.laps.find((x) => x.session_id === o.session && x.number === o.lap);
              return (
                <TextLink key={`${o.session}:${o.lap}`} small onPress={() => toggleOther(o)}
                  label={`Remove ${l?.label ?? `lap ${o.lap} of session ${o.session}`}`} />
              );
            })}
          </View>
        )}
        {folder && folder.id != null && (
          <View style={styles.others}>
            <Label small>Add a lap from another session of the event</Label>
            <SessionSwitcher folder={folder} current={otherId ?? sessionId} onlyTimed link={false}
              onPick={(s) => setOtherId(s.id === sessionId ? null : s.id)} />
            {otherId != null && (
              <View style={styles.laps}>
                {other ? otherLaps.map((l) => lapChoice(otherId, l,
                  shown.others.some((o) => o.session === otherId && o.lap === l.number),
                  () => toggleOther({ session: otherId, lap: l.number })))
                  : <ActivityIndicator color={theme.text} />}
              </View>
            )}
          </View>
        )}
      </View>

      {error && (
        <Notice>
          <Text style={t.error}>{`The racing line couldn’t be read: ${error}`}</Text>
        </Notice>
      )}
      {!data && !error && <ActivityIndicator color={theme.text} style={styles.wait} />}

      {stage}

      {data && data.laps.length > 1 && (
        <Section no={++no} title="Line difference"
          dek="Each lap’s line against the first lap’s, round the lap: above the line is further left, below further right.">
          <LineDiffChart data={data} colors={colors} m={p.m} onSeek={p.seek} height={wide ? 220 : 190} />
        </Section>
      )}
      {data && data.sections.length > 0 && (
        <Section no={++no} title="Corner by corner"
          dek="Where each lap brakes, turns in, meets the apex and picks up the throttle, and its slowest speed; then what differs, in words.">
          <CornerTable data={data} colors={colors} wide={wide} onSeek={p.seek} />
        </Section>
      )}
      {data && (
        <Section no={++no} title="How this is drawn">
          <View style={styles.method}>
            {METHOD.map((m) => <Text key={m} style={t.body}>{m}</Text>)}
          </View>
        </Section>
      )}
      <Colophon left="The Engineer · Racing line" right={dek || undefined} />
    </Page>
  );
}

const METHOD = [
  'Each lap’s line is its GPS path, lined up on the track by moving the whole lap to take out the GPS’s slow drift, '
    + 'then measured left or right of the session’s quickest clean lap. The tarmac is the width the session’s clean laps used.',
  'Same place puts every car at the same metre of the lap: the way to compare lines. Real time puts each car where it '
    + 'was at the same clock time since the line: a ghost race.',
  'Slip, roll, pitch and the tyre loads are estimated from the car’s g; the server’s note at the top says how far the lines can be trusted.',
];

const useStyles = themed((c) => ({
  accuracy: { gap: 6, paddingTop: 10, maxWidth: 820 },
  acc: { ...Type.label, fontSize: 13, color: c.textSecondary },
  pickers: { gap: 8, paddingTop: 16, paddingBottom: 12, borderBottomWidth: 1, borderColor: c.rule },
  lapHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  laps: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 8, alignItems: 'flex-end' },
  others: { gap: 6, paddingTop: 8 },
  wait: { alignSelf: 'flex-start', marginVertical: 20 },
  stage: { gap: 14, paddingTop: 14 },
  stageSide: { flexDirection: 'row', gap: 20, paddingTop: 14, alignItems: 'flex-start' },
  view: { flex: 1, minWidth: 0, gap: 8 },
  hud: { gap: 8 },
  hudSide: { width: 340, gap: 8 },
  method: { gap: 10, maxWidth: 820 },
  note: { fontFamily: Fonts.body, fontSize: 16, color: c.textSecondary },
}));
