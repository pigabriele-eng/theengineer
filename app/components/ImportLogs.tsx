// Upload many logger files at once (MoTeC .ld with their .ldx, CSV exports, zips of whole tests) and follow the
// import: the server makes a session per log in the background. Before picking the files, choose the event they go
// into: an existing one, a new one (name and dates), or by default a new event per zip named after it. When the
// upload has made events, each gets a prompt: name it from its logs, or put it into the same race weekend's event.
// On the web the files can also be dropped, whole folders too, onto a box that opens the picker when clicked.
import * as DocumentPicker from 'expo-document-picker';
import { Link } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';

import { DropZone } from '@/components/DropZone';
import { EventForm } from '@/components/EventForm';
import { AskEventInfo } from '@/components/EventInfoForm';
import { NameNewEvent, Settled, SettledLine } from '@/components/NameNewEvent';
import { SeasonMatch } from '@/components/SeasonMatch';
import { Text, View, useThemeColor } from '@/components/Themed';
import { api, ImportJob } from '@/lib/api';
import { dateRange, eventsApi, FolderSummary } from '@/lib/events';
import { untimedRuns } from '@/lib/emptyRuns';
import { namingApi, NewEvent } from '@/lib/eventNaming';
import { Radius, themed } from '@/constants/Theme';

// The browser's file dialog filters by extension. iOS and Android filter by MIME type only, and a .ld log has
// none, so there every file can be picked and the server skips what isn't a log.
const ACCEPT = Platform.OS === 'web' ? ['.zip', '.ld', '.ldx', '.csv', '.txt'] : ['*/*'];
const WEB = Platform.OS === 'web'; // a folder can be dropped there, and becomes an event as a zip does
const POLL_MS = 1500;
const MAX_POLL_FAILURES = 20; // about half a minute without an answer
const LISTED = 5; // names shown per group before "and N more"

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
// "02_ADACGT4_T01_HOC.zip/02_ADACGT4_T01_HOC/01_D1S1/a.ld" -> "01_D1S1/a.ld"
const shortName = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/');
const list = (names: string[]) =>
  names.slice(0, LISTED).join(', ') + (names.length > LISTED ? ` and ${names.length - LISTED} more` : '');

type Target = { id: number; name: string } | null; // null: a new event per zip, named after it

export function ImportLogs({ onProgress, events, into, big = false }: {
  onProgress: () => void;
  events?: FolderSummary[] | null; // the events to offer; without them (and without into) no choice is shown
  into?: { id: number; name: string }; // upload into this event, no choice
  big?: boolean; // the drop box fills most of the screen (the Upload page)
}) {
  const styles = useStyles();
  const { height } = useWindowDimensions();
  const [uploading, setUploading] = useState<number | null>(null); // how many files are being sent
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>(into ?? null);
  const [making, setMaking] = useState(false);
  const [landed, setLanded] = useState<Target>(null); // the event picked for the upload, once it is done
  const [made, setMade] = useState<{ order: number[]; events: NewEvent[] } | null>(null); // events the upload made
  const [settled, setSettled] = useState<Record<number, Settled>>({}); // named, skipped or put into another event
  const failures = useRef(0);
  const tint = useThemeColor({}, 'tint');
  const running = job != null && (job.status === 'queued' || job.status === 'running');
  const sentTo = useRef<Target>(null);

  // Follow the import until it ends; the session list is refreshed as runs come in.
  useEffect(() => {
    if (!job || !running) return;
    const timer = setTimeout(async () => {
      try {
        const next = await api.importJob(job.id);
        failures.current = 0;
        setError(null);
        if (next.done !== job.done || next.status !== job.status) onProgress();
        setJob(next);
        if (next.status === 'done' && next.session_ids.length) afterImport(next.id);
      } catch (e) {
        failures.current += 1;
        setError(`Can't reach the server: ${(e as Error).message}`);
        if (failures.current < MAX_POLL_FAILURES) {
          setJob({ ...job }); // ask again
        } else {
          setJob({ ...job, status: 'failed', message: 'The server stopped answering. The runs it imported are in the list.' });
          onProgress();
        }
      }
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [job, running, onProgress]);

  // the event picked for the upload; or, when none was, the events the upload made, to be named
  const afterImport = (jobId: number) => {
    if (sentTo.current) return setLanded(sentTo.current);
    loadMade(jobId);
  };
  const loadMade = (jobId: number) =>
    namingApi.newEvents(jobId).then(
      (r) => setMade((m) => ({ order: m?.order ?? r.events.map((e) => e.id), events: r.events })),
      () => {},
    );
  const settle = (eventId: number, s: Settled) => {
    setSettled((all) => ({ ...all, [eventId]: s }));
    onProgress();
    if (job) loadMade(job.id); // the other new events' offers follow: a new name, an event that has gone
  };

  const pick = async () => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ACCEPT,
      multiple: true,
      copyToCacheDirectory: true,
      base64: false,
    });
    if (picked.canceled || !picked.assets?.length) return;
    send(picked.assets.map((a) => ({ uri: a.uri, name: a.name, file: a.file, mimeType: a.mimeType })));
  };

  // picked or dropped, the same upload; a dropped folder's files are named with their path in it
  const send = async (files: Parameters<typeof eventsApi.importInto>[0]) => {
    setError(null);
    setJob(null);
    setLanded(null);
    setMade(null);
    setSettled({});
    setUploading(files.length);
    try {
      failures.current = 0;
      sentTo.current = target;
      setJob(await eventsApi.importInto(files, target?.id ?? null));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(null);
    }
  };

  const busy = uploading != null || running;
  const chip = (on: boolean) => StyleSheet.flatten([styles.chip, on && { borderColor: tint }]);
  const choices = (events ?? []).filter((e) => e.id != null);
  return (
    <View style={styles.box}>
      {!into && events && (
        <View style={styles.into}>
          <Text style={styles.intoLabel}>Upload into</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <Pressable onPress={() => setTarget(null)} style={chip(target == null)} accessibilityRole="radio"
              accessibilityState={{ selected: target == null }} disabled={busy}>
              <Text style={target == null ? { color: tint } : undefined}>
                {WEB ? 'A new event per zip or folder' : 'A new event per zip'}
              </Text>
            </Pressable>
            {target != null && !choices.some((e) => e.id === target.id) && (
              <Pressable style={chip(true)} accessibilityRole="radio" accessibilityState={{ selected: true }}>
                <Text style={{ color: tint }} numberOfLines={1}>{target.name}</Text>
              </Pressable>
            )}
            {choices.map((e) => {
              const on = target?.id === e.id;
              return (
                <Pressable key={e.key} onPress={() => setTarget({ id: e.id!, name: e.name })} style={chip(on)}
                  accessibilityRole="radio" accessibilityState={{ selected: on }} disabled={busy}>
                  <Text style={on ? { color: tint } : undefined} numberOfLines={1}>{e.name}</Text>
                  {dateRange(e.start, e.end) && <Text style={styles.chipSub}>{dateRange(e.start, e.end)}</Text>}
                </Pressable>
              );
            })}
            <Pressable onPress={() => setMaking(true)} style={chip(false)} accessibilityRole="button" disabled={busy}>
              <Text style={{ color: tint }}>＋ New event…</Text>
            </Pressable>
          </ScrollView>
          <Text style={styles.sub}>
            {target == null
              ? 'Logs from a planned event’s track and days go into it. Otherwise ' +
                (WEB ? 'a zip or a dropped folder becomes an event named after it' : 'a zip becomes an event named after the zip') +
                ', and loose logs go to Not in an event.'
              : `Every log in the upload becomes a session of ${target.name}.`}
          </Text>
          {making && (
            <View style={styles.form}>
              <EventForm submitLabel="Make the event" onCancel={() => setMaking(false)}
                onSubmit={async (v) => {
                  const ev = await eventsApi.create(v);
                  setTarget({ id: ev.id!, name: ev.name });
                  setMaking(false);
                  onProgress();
                }} />
            </View>
          )}
        </View>
      )}
      {WEB ? (
        <DropZone accept={ACCEPT} busy={busy} onPick={pick} title="Drop logs, zips or folders here, or click to pick"
          minHeight={big ? Math.max(252, Math.round(height * 0.6)) : undefined}
          hint={into ? 'Into this event' : target ? `Into ${target.name}` : 'A new event per zip or folder'}
          onFiles={(files) => send(files.map((f) => ({ uri: '', name: f.path, file: f.file, mimeType: f.file.type })))} />
      ) : (
        <Pressable style={[styles.button, { borderColor: tint }, big && styles.bigButton]} onPress={pick} disabled={busy}>
          {busy ? (
            <ActivityIndicator color={tint} />
          ) : (
            <Text style={[styles.buttonText, { color: tint }]}>
              {into ? 'Upload logs into this event' : target ? `Upload logs or a zip into ${target.name}` : 'Upload logs or a zip'}
            </Text>
          )}
        </Pressable>
      )}
      {uploading != null && <Text style={styles.sub}>Uploading {plural(uploading, 'file')}…</Text>}
      {job && running && <Progress job={job} />}
      {job && !running && <Summary job={job} onHide={() => setJob(null)} tint={tint} />}
      {job && !running && made?.order.map((id) => {
        if (settled[id]) return <SettledLine key={id} s={settled[id]} />;
        const ev = made.events.find((e) => e.id === id);
        return ev ? <NameNewEvent key={id} ev={ev} onSettled={(s) => settle(id, s)} /> : null;
      })}
      {job && !running && job.session_ids.length > 0 && (
        // which season the upload's events are in: joined by itself, or asked; the event info form follows
        <SeasonMatch runIds={job.session_ids} onChanged={() => { setSettled((s) => ({ ...s })); onProgress(); }} />
      )}
      {job && !running && job.session_ids.length > 0 && (
        <AskEventInfo runIds={job.session_ids} refresh={settled} onSaved={onProgress} />
      )}
      {job && !running && landed && !into && (
        // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
        <Link href={{ pathname: '/event/[id]', params: { id: landed.id } }} asChild>
          <Pressable hitSlop={6}>
            <Text style={StyleSheet.flatten([styles.headline, { color: tint }])}>Open {landed.name} ›</Text>
          </Pressable>
        </Link>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

function Progress({ job }: { job: ImportJob }) {
  const styles = useStyles();
  if (job.total === 0) return <Text style={styles.sub}>Unpacking the upload…</Text>;
  return (
    <Text style={styles.sub}>
      Importing {Math.min(job.done + 1, job.total)} of {plural(job.total, 'run')}…
      {job.current ? ` ${shortName(job.current)}` : ''}
    </Text>
  );
}

function Summary({ job, onHide, tint }: { job: ImportJob; onHide: () => void; tint: string }) {
  const styles = useStyles();
  const imported = job.session_ids.length;
  const byReason = new Map<string, string[]>();
  for (const s of job.skipped) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), shortName(s.file)]);

  return (
    <View style={styles.summary}>
      {job.status === 'failed' ? (
        <Text style={styles.error}>The import failed. {job.message}</Text>
      ) : (
        <Text style={styles.headline}>
          {job.total === 0 && job.errors.length === 0
            ? 'No logger files found in the upload.'
            : `Imported ${plural(imported, 'run')}` +
              (job.errors.length ? `; ${plural(job.errors.length, 'file')} didn't import.` : '.')}
        </Text>
      )}
      {job.status !== 'failed' && job.message && <Text style={styles.error}>{job.message}</Text>}
      {job.errors.slice(0, 10).map((e, i) => (
        <Text key={i} style={styles.error}>
          {shortName(e.file)}: {e.error}
        </Text>
      ))}
      {job.errors.length > 10 && <Text style={styles.error}>and {job.errors.length - 10} more</Text>}
      {[...byReason].map(([reason, names]) => (
        <Text key={reason} style={styles.sub}>
          Skipped {plural(names.length, 'file')} ({reason}): {list(names)}
        </Text>
      ))}
      {untimedRuns(job).length > 0 && (
        <Text style={styles.warn}>
          Laps not timed, the lap beacon is missing: {list(untimedRuns(job).map((u) => u.name ?? u.file))}. Open the
          run to see how to time them.
        </Text>
      )}
      <Pressable onPress={onHide} hitSlop={8}>
        <Text style={{ color: tint }}>Hide</Text>
      </Pressable>
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { gap: 6 },
  into: { gap: 6 },
  intoLabel: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  chips: { flexDirection: 'row', gap: 6 },
  chip: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.control, paddingHorizontal: 10, paddingVertical: 5,
    maxWidth: 220, justifyContent: 'center', backgroundColor: c.surface },
  chipSub: { fontSize: 11, opacity: 0.6 },
  form: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.card, padding: 12, backgroundColor: c.surface },
  button: { borderWidth: 1, borderRadius: Radius.control, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center' },
  bigButton: { minHeight: 252, justifyContent: 'center' },
  buttonText: { fontWeight: '600', fontSize: 16, textAlign: 'center' },
  summary: { gap: 4 },
  headline: { fontWeight: '600' },
  sub: { opacity: 0.7 },
  error: { color: c.error },
  warn: { color: c.warning },
}));
