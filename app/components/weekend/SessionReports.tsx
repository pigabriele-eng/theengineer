// The reports of a weekend's official sessions (Gabriele, 2026-10-07: "a session report, for example after FP1"):
// one line per session (FP1, Q1, R1...), newest first while the weekend runs, each opening that session's report
// (/report?event=<id>&part=<code>). During the weekend these are the main reports; the whole event's is for after it.
// Self-contained: the page around it gives the section and its heading.
import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { ErrorLine, Note } from '@/components/Controls';
import { Text, View } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { dayLabel } from '@/lib/events';
import { poll } from '@/lib/poll';
import { EventParts, Part, partState, partSummary, partsInOrder } from '@/lib/sessionParts';
import { fetchPartReportProgress, fetchParts } from '@/lib/sessionReports';
import { face, TAP, themed, Type, useTheme } from '@/constants/Theme';

const working = (status: string) => status === 'queued' || status === 'running';

/** The event's official sessions (GET /reports/events/{id}/parts): read when the page comes into view, and again
 * while a report is being worked out (lib/poll.ts: less and less often, not while the page is hidden). While one
 * session's report is being worked out (the usual case: the latest run's), only how far it is is asked
 * (?brief=true), and the list is read again once it is done. */
export function useEventParts(eventId: number | null | undefined) {
  const [answer, setAnswer] = useState<EventParts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopPoll = useRef<(() => void) | null>(null);
  const load = useCallback(() => {
    stopPoll.current?.();
    stopPoll.current = null;
    if (eventId == null) return;
    let busy = 0; // the sessions whose reports the last list said were being worked out
    let one: string | null = null; // ... when there was only one, its code
    stopPoll.current = poll(async (wanted) => {
      try {
        if (one != null) {
          const h = await fetchPartReportProgress({ event: eventId, part: one }).catch(() => null); // else the list
          if (!wanted()) return false;
          if (h && working(h.status)) return true;
        }
        const a = await fetchParts(eventId);
        if (!wanted()) return false;
        setAnswer(a);
        setError(null);
        const codes = a.parts.filter((p) => working(p.status)).map((p) => p.code);
        busy = codes.length;
        one = busy === 1 ? codes[0] : null;
        return busy > 0;
      } catch (e) {
        if (wanted()) setError((e as Error).message);
        return busy > 0; // asked again only while something was being worked out
      }
    });
  }, [eventId]);
  useFocusEffect(useCallback(() => {
    load();
    return () => {
      stopPoll.current?.();
      stopPoll.current = null;
    };
  }, [load]));
  return { answer: answer?.event_id === eventId ? answer : null, error };
}

/** The event's official sessions as useEventParts reads them: what a page that reads them itself hands on. */
export type EventPartsRead = ReturnType<typeof useEventParts>;

/** `parts`: the list as the page around it has read it already (the race weekend's After, which shows the report's
 * switcher too): not read again here. */
export default function SessionReports({ eventId, parts: given }: { eventId: number; parts?: EventPartsRead }) {
  const styles = useStyles();
  const own = useEventParts(given ? null : eventId);
  const { answer, error } = given ?? own;
  const parts = useMemo(() => partsInOrder(answer), [answer]);
  return (
    <View>
      {error && <ErrorLine>{`Can’t read the session reports: ${error}`}</ErrorLine>}
      {!answer && !error && <ActivityIndicator style={styles.left} />}
      {answer && parts.length === 0 && (
        <Note>No runs yet: each session’s report comes with its first run’s laps.</Note>
      )}
      {parts.length > 0 && (
        <View style={styles.list}>
          {parts.map((p) => <PartRow key={p.code} eventId={eventId} part={p} days={answer?.start !== answer?.end} />)}
        </View>
      )}
    </View>
  );
}

function PartRow({ eventId, part: p, days }: { eventId: number; part: Part; days: boolean }) {
  const styles = useStyles();
  const c = useTheme();
  const summary = partSummary(p, formatLap);
  const when = [days && p.date ? dayLabel(p.date) : null, p.time].filter(Boolean).join(' ');
  const state = partState(p);
  const open = p.status !== 'empty';
  const body = (
    <>
      <View style={styles.grow}>
        <Text style={styles.name} numberOfLines={1}>{p.title}</Text>
        <Text style={styles.sub} numberOfLines={2}>{[summary, when || null].filter(Boolean).join(' · ')}</Text>
      </View>
      <View style={styles.end}>
        {state && (
          <Text style={StyleSheet.flatten([styles.state, { color: p.status === 'failed' ? c.error : c.textSecondary }])}>
            {state}
          </Text>
        )}
        {open && <Text style={styles.go}>Report →</Text>}
      </View>
    </>
  );
  if (!open) return <View style={styles.row}>{body}</View>;
  return (
    // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
    <Link href={{ pathname: '/report', params: { event: String(eventId), part: p.code } }} asChild>
      <Pressable accessibilityRole="link" style={styles.row}
        accessibilityLabel={`${p.title} report: ${summary}${state ? `. ${state}` : ''}`}>
        {body}
      </Pressable>
    </Link>
  );
}

const useStyles = themed((c) => ({
  left: { alignSelf: 'flex-start', marginTop: 12 },
  list: { borderTopWidth: 1, borderColor: c.rule, maxWidth: 820 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: Math.max(TAP, 56), paddingVertical: 10,
    borderBottomWidth: 1, borderColor: c.separator },
  grow: { flex: 1, minWidth: 0 },
  name: { fontFamily: Type.label.fontFamily, fontSize: 18, letterSpacing: 0.3, color: c.text },
  sub: { fontFamily: face('label', 400), fontSize: 16, lineHeight: 21, color: c.textSecondary, marginTop: 2 },
  end: { alignItems: 'flex-end', gap: 2 },
  state: { ...Type.label, fontSize: 14, letterSpacing: 1.1 },
  go: { ...Type.link, fontSize: 14, color: c.text },
}));
