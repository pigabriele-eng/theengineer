import { useAudioPlayer } from 'expo-audio';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { api, Debrief, DebriefCorner, DebriefPoint, SECTIONS } from '@/lib/api';
import {
  CAUSE_LABEL,
  CheckedPoint,
  DebriefCheck,
  fetchDebriefCheck,
  placeOf,
  saidOf,
  Verdict,
} from '@/lib/debriefCheck';

const POLL_MS = 3000;

// Status colours (good, warning, critical) mark the verdict next to its icon and label, never on their own.
const STATUS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b', none: '#8a8a86' };
const VERDICT: Record<Verdict, { label: string; color: string; glyph: string; ink: string }> = {
  confirmed: { label: 'Matches', color: STATUS.good, glyph: '✓', ink: '#fff' },
  partly: { label: 'Partly matches', color: STATUS.good, glyph: '≈', ink: '#fff' },
  'not seen': { label: "Data doesn't show it", color: STATUS.warning, glyph: '!', ink: '#1a1a19' },
  contradicted: { label: 'Data says the opposite', color: STATUS.critical, glyph: '✕', ink: '#fff' },
  'cannot check': { label: "Can't tell", color: STATUS.none, glyph: '?', ink: '#fff' },
};

const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function DebriefReport() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const debriefId = Number(id);
  const [d, setD] = useState<Debrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [corners, setCorners] = useState<Record<string, DebriefCorner>>({});
  const [check, setCheck] = useState<DebriefCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const player = useAudioPlayer(audioUrl);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');

  const load = useCallback(() => api.debrief(debriefId).then(setD, (e) => setError(e.message)), [debriefId]);

  useEffect(() => {
    load();
  }, [load]);

  // The recording's URL carries the sign-in token, so get it once rather than on every render (a new URL means a new player).
  const hasAudio = !!d?.has_audio;
  useEffect(() => {
    if (hasAudio) api.debriefAudioUrl(debriefId).then(setAudioUrl);
  }, [hasAudio, debriefId]);

  // Recordings are transcribed and structured on the server; check back until that's done.
  const pending = d?.status === 'queued' || d?.status === 'processing';
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [pending, load]);

  // Once the points exist, fetch what the logger recorded at each corner they mention, then check every point
  // against the data. One after the other: each reads the whole log, and the server is small.
  const ready = d?.status === 'ready';
  const hasPoints = !!d?.points.length;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    (async () => {
      try {
        const r = await api.debriefCorners(debriefId);
        if (live) setCorners(r.corners);
      } catch {
        if (live) setCorners({});
      }
      if (!hasPoints) return;
      try {
        const c = await fetchDebriefCheck(debriefId);
        if (live) setCheck(c);
      } catch (e) {
        if (live) setCheckError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [ready, hasPoints, debriefId]);

  const checked = new Map((check?.points ?? []).map((c) => [c.id, c]));

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

      {ready && hasPoints && <CheckSummary check={check} error={checkError} />}

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
                  {checked.get(p.id) && <PointCheck c={checked.get(p.id)!} />}
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

// The verdict as an icon in its status colour plus its label, so colour never carries it alone.
function Badge({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict];
  return (
    <View style={styles.badge}>
      <Dot color={v.color} glyph={v.glyph} ink={v.ink} />
      <Text style={styles.badgeText}>{v.label}</Text>
    </View>
  );
}

function Dot({ color, glyph, ink }: { color: string; glyph: string; ink: string }) {
  return (
    <View style={[styles.dot, { backgroundColor: color }]}>
      <Text style={[styles.dotGlyph, { color: ink }]}>{glyph}</Text>
    </View>
  );
}

// How many points the data backs, where it doesn't (and what that likely means), and what the data shows that
// nobody mentioned.
function CheckSummary({ check, error }: { check: DebriefCheck | null; error: string | null }) {
  if (error || check?.error) {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Against the data</Text>
        <Text style={styles.meta}>The points couldn&apos;t be checked against the data: {error ?? check?.error}</Text>
      </View>
    );
  }
  if (!check) {
    return (
      <View style={[styles.card, styles.pending]}>
        <ActivityIndicator />
        <Text style={styles.meta}>Checking each point against the data…</Text>
      </View>
    );
  }
  const counts = check.agreement ?? { agrees: 0, disagrees: 0, unclear: 0 };
  const order: Verdict[] = ['contradicted', 'not seen'];
  const disagree = check.points
    .filter((p) => p.agreement === 'disagrees')
    .sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict));
  const unmentioned = check.unmentioned ?? [];
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Against the data</Text>
      <Text style={styles.meta}>
        Balance against the car&apos;s normal balance (as in the report), braking and traction against its other
        corners, over the session&apos;s {check.laps ?? 0} clean laps.
      </Text>
      <View style={styles.kpis}>
        <Kpi n={counts.agrees} label="match" verdict="confirmed" />
        <Kpi n={counts.disagrees} label="don't match" verdict="not seen" />
        <Kpi n={counts.unclear} label="can't tell" verdict="cannot check" />
      </View>
      {disagree.length > 0 && (
        <View style={styles.list}>
          <Text style={styles.h3}>Where feedback and data disagree</Text>
          {disagree.map((p) => (
            <Mismatch key={p.id ?? p.text} p={p} />
          ))}
        </View>
      )}
      {unmentioned.length > 0 && (
        <View style={styles.list}>
          <Text style={styles.h3}>The data also shows (not in the debrief)</Text>
          {unmentioned.map((t) => (
            <View key={`${t.section}-${t.phase}`} style={styles.item}>
              <Text style={styles.itemTitle}>
                {t.kind === 'understeer' ? 'Understeer' : 'Oversteer'} at {t.section} {t.phase === 'mid' ? 'mid-corner' : t.phase}
              </Text>
              <Text style={styles.data}>{t.line}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function Kpi({ n, label, verdict }: { n: number; label: string; verdict: Verdict }) {
  const v = VERDICT[verdict];
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiValue}>{n}</Text>
      <View style={styles.badge}>
        <Dot color={v.color} glyph={v.glyph} ink={v.ink} />
        <Text style={styles.meta}>{label}</Text>
      </View>
    </View>
  );
}

function Mismatch({ p }: { p: CheckedPoint }) {
  return (
    <View style={styles.item}>
      <View style={styles.itemHead}>
        <Dot color={VERDICT[p.verdict].color} glyph={VERDICT[p.verdict].glyph} ink={VERDICT[p.verdict].ink} />
        <Text style={styles.itemTitle}>
          {placeOf(p)} · {saidOf(p)}
        </Text>
      </View>
      <Text style={styles.data}>
        {VERDICT[p.verdict].label}: {p.evidence.charAt(0).toLowerCase() + p.evidence.slice(1)}
      </Text>
      <Explained p={p} />
    </View>
  );
}

function Explained({ p }: { p: CheckedPoint }) {
  return (
    <>
      {p.meaning ? (
        <Text style={styles.note}>
          <Text style={styles.strong}>{(p.cause && CAUSE_LABEL[p.cause]) || 'What it means'}: </Text>
          {p.meaning}
        </Text>
      ) : null}
      {p.suggestion ? (
        <Text style={styles.note}>
          <Text style={styles.strong}>Try: </Text>
          {p.suggestion}
        </Text>
      ) : null}
    </>
  );
}

// Under each point: whether the data backs it, in one line, and on request what that likely means.
function PointCheck({ c }: { c: CheckedPoint }) {
  const [open, setOpen] = useState(false);
  const tint = useThemeColor({}, 'tint');
  const more = !!(c.meaning || c.suggestion);
  return (
    <View style={styles.check}>
      <Badge verdict={c.verdict} />
      <Text style={styles.data}>{c.line}</Text>
      {more && (
        <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button">
          <Text style={[styles.more, { color: tint }]}>{open ? 'Hide' : 'What it means'}</Text>
        </Pressable>
      )}
      {open && <Explained p={c} />}
    </View>
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
  data: { fontSize: 13, opacity: 0.75, fontVariant: ['tabular-nums'], lineHeight: 18 },
  card: { borderWidth: 1, borderColor: '#8884', borderRadius: 8, padding: 12, gap: 10 },
  pending: { flexDirection: 'row', alignItems: 'center' },
  cardTitle: { fontSize: 18, fontWeight: '700' },
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: 24 },
  kpi: { gap: 2 },
  kpiValue: { fontSize: 28, fontWeight: '600', fontVariant: ['tabular-nums'] },
  list: { gap: 10 },
  h3: { fontSize: 15, fontWeight: '700' },
  item: { gap: 4, borderTopWidth: 1, borderColor: '#8883', paddingTop: 8 },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  itemTitle: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  note: { fontSize: 14, lineHeight: 20 },
  strong: { fontWeight: '600' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badgeText: { fontSize: 13, fontWeight: '600' },
  dot: { width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  dotGlyph: { fontSize: 11, fontWeight: '700', lineHeight: 14 },
  check: { gap: 4, marginTop: 2 },
  more: { fontSize: 13, fontWeight: '600' },
});
