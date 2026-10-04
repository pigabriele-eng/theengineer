import { useAudioPlayer } from 'expo-audio';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { api, Debrief, DebriefCorner, DebriefPoint, SECTIONS } from '@/lib/api';

const POLL_MS = 3000;

const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function DebriefReport() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const debriefId = Number(id);
  const [d, setD] = useState<Debrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [corners, setCorners] = useState<Record<string, DebriefCorner>>({});
  const player = useAudioPlayer(d?.has_audio ? api.debriefAudioUrl(debriefId) : null);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');

  const load = useCallback(() => api.debrief(debriefId).then(setD, (e) => setError(e.message)), [debriefId]);

  useEffect(() => {
    load();
  }, [load]);

  // Recordings are transcribed and structured on the server; check back until that's done.
  const pending = d?.status === 'queued' || d?.status === 'processing';
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [pending, load]);

  // Once the points exist, fetch what the logger recorded at each corner they mention.
  const ready = d?.status === 'ready';
  useEffect(() => {
    if (!ready) return;
    api.debriefCorners(debriefId).then((r) => setCorners(r.corners), () => setCorners({}));
  }, [ready, debriefId]);

  const retry = async () => {
    setError(null);
    try {
      setD(await api.processDebrief(debriefId));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const playFrom = async (s: number) => {
    await player.seekTo(s);
    player.play();
  };

  const who = (p: DebriefPoint) => {
    const sp = p.speaker ? d?.speakers?.[p.speaker] : null;
    return sp ? sp.name ?? sp.role : null;
  };

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Debrief report' }} />
      {!d && !error && <ActivityIndicator />}
      {error && <Text style={styles.error}>{error}</Text>}

      {pending && (
        <View style={styles.banner}>
          <ActivityIndicator />
          <Text style={styles.bannerText}>
            {d?.status === 'queued' ? 'Recording saved. Waiting to be processed…' : 'Transcribing and structuring…'}
          </Text>
        </View>
      )}

      {d?.status === 'failed' && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>The recording is saved, but it couldn't be processed: {d.error}</Text>
          <Pressable style={[styles.secondary, { borderColor: tint }]} onPress={retry}>
            <Text style={{ color: tint, fontWeight: '600' }}>Try again</Text>
          </Pressable>
        </View>
      )}

      {d?.summary ? <Text style={styles.summary}>{d.summary}</Text> : null}

      {d &&
        SECTIONS.map(([key, name]) => {
          const points = d.points.filter((p) => p.section === key);
          if (!points.length) return null;
          return (
            <View key={key} style={styles.section}>
              <Text style={styles.h2}>{name}</Text>
              {points.map((p) => (
                <View key={p.id} style={styles.point}>
                  <Text style={styles.pointText}>{p.text}</Text>
                  <View style={styles.tags}>
                    {p.corner_code && <Tag text={p.corner_code} />}
                    {p.phase && <Tag text={p.phase} />}
                    {who(p) && <Text style={styles.meta}>{who(p)}</Text>}
                    {p.audio_start_s != null && d.has_audio && (
                      <Pressable onPress={() => playFrom(p.audio_start_s!)} accessibilityLabel="Play from here">
                        <Text style={[styles.meta, { color: tint }]}>▶ {stamp(p.audio_start_s)}</Text>
                      </Pressable>
                    )}
                  </View>
                  {p.corner_code && corners[p.corner_code] && <CornerLine c={corners[p.corner_code]} />}
                </View>
              ))}
            </View>
          );
        })}

      {d?.status === 'ready' && d.points.length === 0 && <Text style={styles.meta}>No points in this debrief.</Text>}

      {d?.transcript && (
        <Pressable onPress={() => setShowTranscript((s) => !s)}>
          <Text style={[styles.link, { color: tint }]}>{showTranscript ? 'Hide transcript' : 'Show transcript'}</Text>
        </Pressable>
      )}
      {showTranscript && <Text style={styles.transcript}>{named(d?.transcript ?? '', d?.speakers ?? null)}</Text>}
    </ScrollView>
  );
}

// Transcript lines start with a speaker label ("S1: ..."); show who that is once it's known.
function named(transcript: string, speakers: Debrief['speakers']) {
  return transcript.replace(/^(S\d+):/gm, (label, key: string) => {
    const sp = speakers?.[key];
    return sp ? `${sp.name ?? sp.role}:` : label;
  });
}

// What the logger recorded at the corner: the reference lap, and the best lap through it if different.
function CornerLine({ c }: { c: DebriefCorner }) {
  const r = c.reference;
  if (!r) return null;
  const parts = [
    r.brake_point != null ? `brake ${r.brake_point} m` : null,
    `min ${r.min_speed.toFixed(1)} km/h`,
    r.full_throttle != null ? `full throttle ${r.full_throttle} m` : null,
    `section ${r.time.toFixed(2)} s`,
  ].filter(Boolean);
  const best = c.best && c.best_lap !== c.reference_lap
    ? ` · best L${c.best_lap} ${c.best.time.toFixed(2)} s, min ${c.best.min_speed.toFixed(1)}`
    : '';
  return (
    <Text style={styles.data}>
      Data L{c.reference_lap}: {parts.join(' · ')}
      {best}
    </Text>
  );
}

function Tag({ text }: { text: string }) {
  return (
    <View style={styles.tag}>
      <Text style={styles.tagText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16 },
  error: { color: '#c8372d' },
  banner: { gap: 10, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#8884' },
  bannerText: { opacity: 0.8 },
  secondary: { borderWidth: 1, borderRadius: 8, padding: 10, alignItems: 'center' },
  summary: { fontSize: 17, lineHeight: 24 },
  section: { gap: 8 },
  h2: { fontSize: 18, fontWeight: '700' },
  point: { borderLeftWidth: 3, borderColor: '#8886', paddingLeft: 10, gap: 4 },
  pointText: { fontSize: 16, lineHeight: 22 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  tag: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, backgroundColor: '#8882' },
  tagText: { fontSize: 12, fontWeight: '600' },
  meta: { fontSize: 13, opacity: 0.7, fontVariant: ['tabular-nums'] },
  link: { fontWeight: '600' },
  transcript: { opacity: 0.8, lineHeight: 20 },
  data: { fontSize: 13, opacity: 0.75, fontVariant: ['tabular-nums'] },
});
