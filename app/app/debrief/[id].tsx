import { useAudioPlayer } from 'expo-audio';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { FigRow, Notice, PageHead, useText } from '@/components/Picks';
import PrintButton from '@/components/PrintButton';
import { Colophon, Fig, Label, Page, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
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
import { face, Fonts, inkOn, Palette, themed, Type, useTheme } from '@/constants/Theme';

const POLL_MS = 3000;

// Status colours (good, warning, critical) mark the verdict next to its icon and label, never on their own.
const VERDICT: Record<Verdict, { label: string; status: keyof Palette['status']; glyph: string }> = {
  confirmed: { label: 'Matches', status: 'good', glyph: '✓' },
  partly: { label: 'Partly matches', status: 'good', glyph: '≈' },
  'not seen': { label: "Data doesn't show it", status: 'warning', glyph: '!' },
  contradicted: { label: 'Data says the opposite', status: 'critical', glyph: '✕' },
  'cannot check': { label: "Can't tell", status: 'none', glyph: '?' },
};

const MODE_NAME = { individual: 'One driver', group: 'Group' } as const;
const LANGUAGE_NAME = { en: 'English', it: 'Italiano', de: 'Deutsch', multi: 'Mixed languages' } as const;

const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const day = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function DebriefReport() {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
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

  let no = 0;
  const dek = d ? [MODE_NAME[d.mode] ?? d.mode, LANGUAGE_NAME[d.language] ?? d.language, day(d.created_at)]
    .filter(Boolean).join(' · ') : undefined;

  return (
    <Page>
      <Stack.Screen options={{ title: 'Debrief report' }} />
      <PageHead title="Debrief report" dek={dek}>
        <View style={styles.headLinks}>
          {d ? <TextLink label="Open the session" href={`/session/${d.session_id}`} arrow small /> : null}
          <PrintButton title={['Debrief report', dek].filter(Boolean).join(' · ')} />
        </View>
      </PageHead>

      {!d && !error && <ActivityIndicator color={theme.text} style={styles.loading} />}
      {error && <Text style={StyleSheet.flatten([t.error, styles.gapTop])}>{error}</Text>}

      {pending && (
        <Notice busy style={styles.notice}>
          <Text style={t.body}>
            {d?.status === 'queued' ? 'Recording saved. Waiting to be processed…' : 'Transcribing and structuring…'}
          </Text>
        </Notice>
      )}

      {d?.status === 'failed' && (
        <Notice style={styles.notice}>
          <Text style={t.body}>The recording is saved, but it couldn&apos;t be processed: {d.error}</Text>
          <TextLink label="Try again" onPress={retry} red />
        </Notice>
      )}

      {d?.summary ? <Text style={StyleSheet.flatten([t.lead, styles.summary])}>{d.summary}</Text> : null}

      {ready && hasPoints && <CheckSummary no={++no} check={check} error={checkError} />}

      {d &&
        SECTIONS.map(([key, name]) => {
          const points = d.points.filter((p) => p.section === key);
          if (!points.length) return null;
          return (
            <Section key={key} no={++no} title={name}>
              <View style={styles.points}>
                {points.map((p) => (
                  <View key={p.id} style={styles.point}>
                    <Text style={styles.pointText}>{p.text}</Text>
                    {(p.corner_code || p.phase || who(p) || (p.audio_start_s != null && d.has_audio)) && (
                      <View style={styles.tags}>
                        {p.corner_code && <Text style={styles.code}>{p.corner_code}</Text>}
                        {p.phase && <Label small>{p.phase}</Label>}
                        {who(p) && <Label small muted>{who(p)}</Label>}
                        {p.audio_start_s != null && d.has_audio && (
                          <TextLink label={`▶ ${stamp(p.audio_start_s)}`} onPress={() => playFrom(p.audio_start_s!)} small />
                        )}
                      </View>
                    )}
                    {p.corner_code && corners[p.corner_code] && <CornerLine c={corners[p.corner_code]} />}
                    {checked.get(p.id) && <PointCheck c={checked.get(p.id)!} />}
                  </View>
                ))}
              </View>
            </Section>
          );
        })}

      {d?.status === 'ready' && d.points.length === 0 && (
        <Text style={StyleSheet.flatten([t.note, styles.gapTop])}>No points in this debrief.</Text>
      )}

      {d?.transcript ? (
        <Section no={++no} title="Transcript">
          <TextLink label={showTranscript ? 'Hide transcript' : 'Show transcript'} onPress={() => setShowTranscript((s) => !s)} />
          {showTranscript && <Text style={StyleSheet.flatten([t.note, styles.transcript])}>{named(d.transcript, d.speakers)}</Text>}
        </Section>
      ) : null}

      <Colophon left="Debrief report" right={d ? day(d.created_at) : undefined} />
    </Page>
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
  const styles = useStyles();
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
      <Text style={styles.dataLabel}>Data L{c.reference_lap}  </Text>
      {parts.join(' · ')}
      {best}
    </Text>
  );
}

// The verdict as an icon in its status colour plus its label, so colour never carries it alone.
function Badge({ verdict }: { verdict: Verdict }) {
  const styles = useStyles();
  const v = VERDICT[verdict];
  return (
    <View style={styles.badge}>
      <Glyph status={v.status} glyph={v.glyph} />
      <Text style={styles.badgeText}>{v.label}</Text>
    </View>
  );
}

/** The verdict's icon: a flat square of its status colour with the sign on it. */
function Glyph({ status, glyph, size = 18 }: { status: keyof Palette['status']; glyph: string; size?: number }) {
  const styles = useStyles();
  const color = useTheme().status[status];
  return (
    <View style={StyleSheet.flatten([styles.glyph, { width: size, height: size, backgroundColor: color }])}>
      <Text style={StyleSheet.flatten([styles.glyphText, { color: inkOn(color), fontSize: Math.round(size * 0.62),
        lineHeight: size }])}>{glyph}</Text>
    </View>
  );
}

// How many points the data backs, where it doesn't (and what that likely means), and what the data shows that
// nobody mentioned.
function CheckSummary({ no, check, error }: { no: number; check: DebriefCheck | null; error: string | null }) {
  const styles = useStyles();
  const t = useText();
  const wide = useWide();
  const dek = check && !check.error
    ? `Balance against the car's normal balance (as in the report), braking and traction against its other corners, ` +
      `over the session's ${check.laps ?? 0} clean laps.`
    : undefined;
  if (error || check?.error) {
    return (
      <Section no={no} title="Against the data">
        <Text style={t.note}>The points couldn&apos;t be checked against the data: {error ?? check?.error}</Text>
      </Section>
    );
  }
  if (!check) {
    return (
      <Section no={no} title="Against the data">
        <Notice busy><Text style={t.body}>Checking each point against the data…</Text></Notice>
      </Section>
    );
  }
  const counts = check.agreement ?? { agrees: 0, disagrees: 0, unclear: 0 };
  const order: Verdict[] = ['contradicted', 'not seen'];
  const disagree = check.points
    .filter((p) => p.agreement === 'disagrees')
    .sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict));
  const unmentioned = check.unmentioned ?? [];
  return (
    <Section no={no} title="Against the data" dek={dek}>
      <FigRow phoneCols={3}>
        <Kpi n={counts.agrees} label="Match" verdict="confirmed" size={wide ? 72 : 48} />
        <Kpi n={counts.disagrees} label="Don't match" verdict="not seen" size={wide ? 72 : 48} />
        <Kpi n={counts.unclear} label="Can't tell" verdict="cannot check" size={wide ? 72 : 48} />
      </FigRow>
      {(disagree.length > 0 || unmentioned.length > 0) && (
        <View style={wide ? styles.twoCols : styles.oneCol}>
          {disagree.length > 0 && (
            <View style={wide ? styles.col : undefined}>
              <Text style={t.sub}>Where feedback and data disagree</Text>
              {disagree.map((p) => (
                <Mismatch key={p.id ?? p.text} p={p} />
              ))}
            </View>
          )}
          {unmentioned.length > 0 && (
            <View style={wide ? styles.col : undefined}>
              <Text style={t.sub}>The data also shows (not in the debrief)</Text>
              {unmentioned.map((u) => (
                <View key={`${u.section}-${u.phase}`} style={styles.item}>
                  <Text style={styles.itemTitle}>
                    {u.kind === 'understeer' ? 'Understeer' : 'Oversteer'} at {u.section} {u.phase === 'mid' ? 'mid-corner' : u.phase}
                  </Text>
                  <Text style={styles.data}>{u.line}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </Section>
  );
}

function Kpi({ n, label, verdict, size }: { n: number; label: string; verdict: Verdict; size: number }) {
  const styles = useStyles();
  const v = VERDICT[verdict];
  const color = useTheme().status[v.status];
  const wide = useWide();
  return (
    <View>
      {/* two lines of label kept on a phone, so the three figures stay level when one label wraps */}
      <View style={StyleSheet.flatten([styles.kpiHead, !wide && styles.kpiHeadPhone])}>
        <Glyph status={v.status} glyph={v.glyph} size={16} />
        <Label small>{label}</Label>
      </View>
      <Fig value={String(n)} size={size} bar={color} barHeight={6} />
    </View>
  );
}

function Mismatch({ p }: { p: CheckedPoint }) {
  const styles = useStyles();
  return (
    <View style={styles.item}>
      <View style={styles.itemHead}>
        <Glyph status={VERDICT[p.verdict].status} glyph={VERDICT[p.verdict].glyph} />
        <Text style={styles.itemTitle}>
          {placeOf(p)} · {saidOf(p)}
        </Text>
      </View>
      <Text style={styles.data}>
        <Text style={styles.dataLabel}>{VERDICT[p.verdict].label}  </Text>
        {p.evidence.charAt(0).toLowerCase() + p.evidence.slice(1)}
      </Text>
      <Explained p={p} />
    </View>
  );
}

function Explained({ p }: { p: CheckedPoint }) {
  const t = useText();
  return (
    <>
      {p.meaning ? (
        <Text style={t.note}>
          <Text style={t.strong}>{(p.cause && CAUSE_LABEL[p.cause]) || 'What it means'}: </Text>
          {p.meaning}
        </Text>
      ) : null}
      {p.suggestion ? (
        <Text style={t.note}>
          <Text style={t.strong}>Try: </Text>
          {p.suggestion}
        </Text>
      ) : null}
    </>
  );
}

// Under each point: whether the data backs it, in one line, and on request what that likely means.
function PointCheck({ c }: { c: CheckedPoint }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const more = !!(c.meaning || c.suggestion);
  return (
    <View style={styles.check}>
      <Badge verdict={c.verdict} />
      <Text style={styles.data}>{c.line}</Text>
      {more && <TextLink label={open ? 'Hide' : 'What it means'} onPress={() => setOpen((o) => !o)} small />}
      {open && <Explained p={c} />}
    </View>
  );
}

const useStyles = themed((c) => ({
  headLinks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 20, rowGap: 8, marginTop: 6 },
  loading: { alignSelf: 'flex-start', marginTop: 24 },
  gapTop: { marginTop: 18 },
  notice: { marginTop: 24 },
  summary: { marginTop: 24, maxWidth: 820 },
  points: { borderTopWidth: 1, borderColor: c.rule, maxWidth: 860 },
  point: { gap: 6, paddingTop: 12, paddingBottom: 14, borderBottomWidth: 1, borderColor: c.separator },
  pointText: { fontFamily: face('body', 600), fontSize: 18, lineHeight: 25, color: c.text },
  tags: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 6, alignItems: 'center' },
  code: { fontFamily: Fonts.display, fontSize: 18, lineHeight: 21, textTransform: 'uppercase', color: c.text },
  data: { ...Type.number, fontSize: 13, lineHeight: 19, color: c.textSecondary },
  dataLabel: { ...Type.label, fontSize: 11, color: c.text },
  transcript: { marginTop: 14, maxWidth: 760 },
  twoCols: { flexDirection: 'row', gap: 40, marginTop: 30, alignItems: 'flex-start' },
  oneCol: { gap: 28, marginTop: 26 },
  col: { flex: 1, minWidth: 0 },
  kpiHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  kpiHeadPhone: { alignItems: 'flex-start', minHeight: 32 },
  item: { gap: 5, paddingTop: 10, paddingBottom: 12, borderBottomWidth: 1, borderColor: c.separator },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  itemTitle: { fontFamily: face('body', 600), fontSize: 16, lineHeight: 22, color: c.text, flexShrink: 1 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badgeText: { ...Type.label, fontSize: 12, color: c.text },
  glyph: { alignItems: 'center', justifyContent: 'center' },
  glyphText: { fontFamily: face('label', 700), textAlign: 'center' },
  check: { gap: 5, marginTop: 4, paddingLeft: 12, borderLeftWidth: 3, borderColor: c.rule },
}));
