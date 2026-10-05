import * as DocumentPicker from 'expo-document-picker';
import { Link, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { LapCompare } from '@/components/LapCompare';
import { SetupCard } from '@/components/SetupCard';
import { Text, View, useThemeColor } from '@/components/Themed';
import { TrackMap } from '@/components/TrackMap';
import { Analysis, api, Debrief, DETECTED_CORNERS_NOTE, formatLap, SessionDetail } from '@/lib/api';

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionId = Number(id);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [debriefs, setDebriefs] = useState<Debrief[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');

  const load = useCallback(async () => {
    try {
      const s = await api.session(sessionId);
      setSession(s);
      setDebriefs(await api.debriefs(sessionId));
      setAnalysis(s.files.length ? await api.analysis(sessionId) : null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionId]);
  useEffect(() => {
    load();
  }, [load]);

  const upload = async () => {
    const pick = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (pick.canceled) return;
    const asset = pick.assets[0];
    setBusy(true);
    setError(null);
    try {
      await api.uploadFile(sessionId, { uri: asset.uri, name: asset.name, file: asset.file });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const best = session?.best_lap_s;
  const title = session?.name ?? 'Session';

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Stack.Screen
        options={{
          title: [title, session?.track_name].filter(Boolean).join(' · '),
          headerTitle: () => <HeaderTitle title={title} venue={session?.track_name} />,
        }}
      />
      <View style={styles.facts}>
        <Fact label="Best lap" value={formatLap(best)} />
        <Fact label="Theoretical best" value={formatLap(analysis?.theoretical_best)} />
        <Fact label="Laps" value={String(session?.laps.length ?? 0)} />
      </View>
      {/* Link asChild hands its child's style to a web anchor, which can't take a style array: one object */}
      {session?.laps.some((l) => l.clean) && (
        <Link href={{ pathname: '/report', params: { session: sessionId } }} asChild>
          <Pressable style={StyleSheet.flatten([styles.button, { backgroundColor: tint }])}>
            <Text style={styles.buttonText}>Report: how to go faster</Text>
          </Pressable>
        </Link>
      )}
      {/* drawn from a clean lap; keyed so an upload that changes the laps redraws it */}
      {session?.laps.some((l) => l.clean) && <TrackMap key={`${session.files.length}-${best}`} session={sessionId} />}

      <Pressable style={[styles.button, { backgroundColor: tint }]} onPress={upload} disabled={busy}>
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Upload a logger file (MoTeC .ld/.ldx, or a CSV export)</Text>
        )}
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
      {/* Link asChild hands its child's style to a web anchor, which can't take a style array: one object */}
      {(session?.laps.length ?? 0) > 0 && (
        <Link href={{ pathname: '/tools/stint', params: { session: sessionId } }} asChild>
          <Pressable style={StyleSheet.flatten([styles.button, styles.outline, { borderColor: tint }])}>
            <Text style={[styles.buttonText, { color: tint }]}>Stint analysis</Text>
          </Pressable>
        </Link>
      )}
      {session?.best_lap_s != null && (
        <Link href={{ pathname: '/compare', params: { session: sessionId } }} asChild>
          <Pressable style={StyleSheet.flatten([styles.button, styles.outline, { borderColor: tint }])}>
            <Text style={[styles.buttonText, { color: tint }]}>Compare with other sessions and drivers</Text>
          </Pressable>
        </Link>
      )}

      <SetupCard sessionId={sessionId} />

      {debriefs.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.h2}>Debriefs</Text>
          {debriefs.map((d) => (
            <Link key={d.id} href={{ pathname: '/debrief/[id]', params: { id: d.id } }} asChild>
              <Pressable style={styles.corner}>
                <Text style={styles.cornerTitle}>
                  {new Date(d.created_at).toLocaleString()} · {d.mode === 'group' ? 'group' : 'driver'}
                </Text>
                <Text style={styles.sub} numberOfLines={2}>
                  {d.status === 'ready'
                    ? d.summary || `${d.points.length} points`
                    : d.status === 'failed'
                      ? 'Not processed yet'
                      : 'Processing…'}
                </Text>
              </Pressable>
            </Link>
          ))}
        </View>
      )}

      {analysis && session && analysis.corners.length > 0 && (
        <LapCompare sessionId={sessionId} analysis={analysis} laps={session.laps} />
      )}

      {analysis && (
        <View style={styles.section}>
          <Text style={styles.h2}>Corners vs best lap {analysis.reference_lap}</Text>
          {analysis.numbering === 'detected' && analysis.corners.length > 0 && (
            <Text style={styles.note}>{DETECTED_CORNERS_NOTE}</Text>
          )}
          {analysis.corners.map((c) => {
            const ref = c.laps[String(analysis.reference_lap)];
            const top = c.laps[String(c.best_lap)];
            return (
              <View key={c.code} style={styles.corner}>
                <Text style={styles.cornerTitle}>
                  {c.code} · {Math.round(c.apex_m)} m
                </Text>
                <Text style={styles.sub}>
                  {ref.time.toFixed(2)} s on lap {analysis.reference_lap} · best {top.time.toFixed(2)} s on lap{' '}
                  {c.best_lap}
                </Text>
                <Text style={styles.sub}>
                  Brake {ref.brake_point ?? '–'} m · min {ref.min_speed.toFixed(1)} km/h · full throttle{' '}
                  {ref.full_throttle ?? '–'} m
                </Text>
              </View>
            );
          })}
        </View>
      )}

      {session && session.laps.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.h2}>Laps</Text>
          {session.laps.map((l) => (
            <View key={`${l.file_id}-${l.number}`} style={styles.lap}>
              <Text style={[styles.lapNo, !l.clean && styles.dim]}>L{l.number}</Text>
              <Text style={[styles.time, !l.clean && styles.dim, l.time_s === best && { color: tint }]}>
                {formatLap(l.time_s)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// The session's name with the track it was driven at under it.
function HeaderTitle({ title, venue }: { title: string; venue?: string | null }) {
  return (
    <View style={styles.headerTitle}>
      <Text style={styles.headerName} numberOfLines={1}>
        {title}
      </Text>
      {venue ? (
        <Text style={styles.headerVenue} numberOfLines={1}>
          {venue}
        </Text>
      ) : null}
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16 },
  headerTitle: { backgroundColor: 'transparent', flexShrink: 1 },
  headerName: { fontSize: 17, fontWeight: '600' },
  headerVenue: { fontSize: 12, opacity: 0.6 },
  facts: { flexDirection: 'row', gap: 24, flexWrap: 'wrap' },
  fact: { gap: 2 },
  factLabel: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  factValue: { fontSize: 24, fontWeight: '600', fontVariant: ['tabular-nums'] },
  button: { borderRadius: 8, padding: 14, alignItems: 'center' },
  outline: { borderWidth: 1, backgroundColor: 'transparent' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  error: { color: '#c8372d' },
  section: { gap: 8 },
  h2: { fontSize: 18, fontWeight: '700' },
  corner: { paddingVertical: 8, borderBottomWidth: 1, borderColor: '#8882', gap: 2 },
  cornerTitle: { fontSize: 16, fontWeight: '600' },
  sub: { opacity: 0.7, fontVariant: ['tabular-nums'] },
  note: { fontSize: 12, opacity: 0.6 },
  lap: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  lapNo: { fontVariant: ['tabular-nums'] },
  time: { fontVariant: ['tabular-nums'], fontSize: 16 },
  dim: { opacity: 0.4 },
});
