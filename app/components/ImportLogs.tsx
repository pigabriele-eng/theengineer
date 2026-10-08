// Upload many logger files at once (MoTeC .ld with their .ldx, CSV exports, zips of whole tests) and follow the
// import: the files go out with their byte progress, then the server makes a run per log in the background and the
// same bar follows it run by run, with the time left of the whole upload and of the stage it is at (UploadEta.tsx).
// Before picking the files, choose the event they go into: an existing one, a new one (name and dates), or by default
// a new event per zip named after it. When the upload has made events, each gets a prompt: name it from its logs, or
// put it into the same race weekend's event. Under the upload's result, the tyres of each stint it brought, the app's
// guess ticked (components/TyrePicks.tsx). On the web the files can also be dropped, whole folders too, onto a box
// that opens the picker when clicked.
import * as DocumentPicker from 'expo-document-picker';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, useWindowDimensions } from 'react-native';

import { Choice, Choices, ErrorLine, Field, Note, ProgressBar } from '@/components/Controls';
import { DropZone } from '@/components/DropZone';
import { EventForm } from '@/components/EventForm';
import { NameNewEvent, Settled, SettledLine } from '@/components/NameNewEvent';
import { Block, TextLink, useWide } from '@/components/Programme';
import { SeasonMatch } from '@/components/SeasonMatch';
import { UploadTyres } from '@/components/TyrePicks';
import { Text, View } from '@/components/Themed';
import { EtaLines, EtaText, useUploadEta } from '@/components/UploadEta';
import { api, ImportJob } from '@/lib/api';
import { untimedRuns } from '@/lib/emptyRuns';
import { namingApi, NewEvent } from '@/lib/eventNaming';
import { warmResults } from '@/lib/finishes';
import { dateRange, eventsApi, FolderSummary } from '@/lib/events';
import { uploadRunIds } from '@/lib/tyrePicks';
import { PickedFile, Retry, sendImport, sizeOf } from '@/lib/upload';
import { Fonts, inkOn, themed, Type, useTheme } from '@/constants/Theme';

// The browser's file dialog filters by extension. iOS and Android filter by MIME type only, and a .ld log has
// none, so there every file can be picked and the server skips what isn't a log.
const ACCEPT = Platform.OS === 'web' ? ['.zip', '.ld', '.ldx', '.csv', '.txt'] : ['*/*'];
const WEB = Platform.OS === 'web'; // a folder can be dropped there, and becomes an event as a zip does
const POLL_MS = 1500;
// about three minutes without an answer: long enough for the server to restart (a deploy, or Render's free plan
// waking it), after which an import it was running is sent again (RESENDS)
const MAX_POLL_FAILURES = 120;
const RESENDS = 2;
const RESTARTED = 'The server restarted'; // the start of a job's message when a restart ended it (imports.INTERRUPTED)
const LISTED = 5; // names shown per group before "and N more"
const CHECKING = 'Checking '; // the server's `current` while it checks the logs (server/app/routers/imports.py)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
// "02_ADACGT4_T01_HOC.zip/02_ADACGT4_T01_HOC/01_D1S1/a.ld" -> "01_D1S1/a.ld"
const shortName = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/');
const list = (names: string[]) =>
  names.slice(0, LISTED).join(', ') + (names.length > LISTED ? ` and ${names.length - LISTED} more` : '');
const mb = (bytes: number) => (bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1);

type Target = { id: number; name: string } | null; // null: a new event per zip, named after it
type Sending = { files: number; loaded: number; total: number; zipBytes: number }; // the files going out, in bytes

export function ImportLogs({ onProgress, events, into, big = false }: {
  onProgress: () => void;
  events?: FolderSummary[] | null; // the events to offer; without them (and without into) no choice is shown
  into?: { id: number; name: string }; // upload into this event, no choice
  big?: boolean; // the drop box fills most of the screen (the Upload page)
}) {
  const styles = useStyles();
  const { height } = useWindowDimensions();
  const [sending, setSending] = useState<Sending | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>(into ?? null);
  const [making, setMaking] = useState(false);
  const [landed, setLanded] = useState<Target>(null); // the event picked for the upload, once it is done
  const [made, setMade] = useState<{ order: number[]; events: NewEvent[] } | null>(null); // events the upload made
  const [settled, setSettled] = useState<Record<number, Settled>>({}); // named, skipped or put into another event
  const failures = useRef(0);
  const [retry, setRetry] = useState<Retry | null>(null); // the upload cut off, being sent again
  const files = useRef<PickedFile[]>([]); // the files of the upload, to send again after a server restart
  const resends = useRef(0);
  const running = job != null && (job.status === 'queued' || job.status === 'running');
  const sentTo = useRef<Target>(null);

  // Follow the import until it ends; the run list is refreshed as runs come in.
  useEffect(() => {
    if (!job || !running) return;
    const timer = setTimeout(async () => {
      try {
        const next = await api.importJob(job.id);
        failures.current = 0;
        setError(null);
        if (next.done !== job.done || next.status !== job.status) onProgress();
        // a restart ended the import (the files it had are gone with it): sent again, the logs it took in left out
        if (next.status === 'failed' && next.message?.startsWith(RESTARTED) && resends.current < RESENDS
          && files.current.length) {
          resends.current += 1;
          onProgress();
          send(files.current, true);
          return;
        }
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
  // (and the official results worked out for the events it went into, so their finishes show on the list)
  const afterImport = (jobId: number) => {
    if (sentTo.current) {
      warmResults([sentTo.current.id]);
      return setLanded(sentTo.current);
    }
    loadMade(jobId, true);
  };
  const loadMade = (jobId: number, first = false) =>
    namingApi.newEvents(jobId).then(
      (r) => {
        if (first) warmResults(r.events.map((e) => e.id));
        setMade((m) => ({ order: m?.order ?? r.events.map((e) => e.id), events: r.events }));
      },
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
    send(picked.assets.map((a) => ({ uri: a.uri, name: a.name, file: a.file, mimeType: a.mimeType, size: a.size })));
  };

  // picked or dropped, the same upload; a dropped folder's files are named with their path in it
  const send = async (picked: PickedFile[], again = false) => {
    files.current = picked;
    if (!again) resends.current = 0;
    setError(null);
    setJob(null);
    setLanded(null);
    setMade(null);
    setSettled({});
    setSending({ files: picked.length, loaded: 0, total: sizeOf(picked),
      zipBytes: sizeOf(picked.filter((f) => /\.zip$/i.test(f.name))) });
    try {
      failures.current = 0;
      sentTo.current = target;
      setJob(await sendImport(picked, target?.id ?? null, (s) => setSending((x) => x && { ...x, ...s }), setRetry));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(null);
      setRetry(null);
    }
  };

  const busy = sending != null || running;
  const eta = useUploadEta(sending, job);
  const choices = (events ?? []).filter((e) => e.id != null);
  const progress = busy ? <UploadStatus sending={sending} job={job} eta={eta} /> : null;
  return (
    <View style={styles.box}>
      {!into && events && (
        <Field label="Upload into">
          <Choices>
            <Choice label={WEB ? 'A new event per zip or folder' : 'A new event per zip'} on={target == null}
              onPress={() => setTarget(null)} disabled={busy} />
            {target != null && !choices.some((e) => e.id === target.id) && (
              <Choice label={target.name} on onPress={() => {}} />
            )}
            {choices.map((e) => (
              <Choice key={e.key} label={e.name} sub={dateRange(e.start, e.end)} on={target?.id === e.id} disabled={busy}
                onPress={() => setTarget({ id: e.id!, name: e.name })} />
            ))}
            <Choice label="+ New event" on={false} add onPress={() => setMaking(true)} disabled={busy} />
          </Choices>
          <Note>
            {target == null
              ? 'Logs from a planned event’s track and days go into it. Otherwise ' +
                (WEB ? 'a zip or a dropped folder becomes an event named after it' : 'a zip becomes an event named after the zip') +
                ', and loose logs go to Not in an event.'
              : `Every log in the upload becomes a run of ${target.name}.`}
          </Note>
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
        </Field>
      )}
      {WEB ? (
        <DropZone accept={ACCEPT} busy={busy} onPick={pick} title="Drop logs, zips or folders here"
          action="or click to pick them" progress={progress}
          minHeight={big ? Math.max(252, Math.round(height * 0.55)) : undefined}
          hint={into ? `Into ${into.name}` : target ? `Into ${target.name}` : 'A new event per zip or folder'}
          onFiles={(files) => send(files.map((f) => ({ uri: '', name: f.path, file: f.file, mimeType: f.file.type })))} />
      ) : (
        <PickBox big={big} busy={busy} onPick={pick} progress={progress}
          title={into ? 'Upload logs into this event' : target ? `Upload logs or a zip into ${target.name}` : 'Upload logs or a zip'} />
      )}
      {job && !running && <UploadStatus sending={null} job={job} />}
      {job && !running && <Summary job={job} onHide={() => setJob(null)} />}
      {job?.status === 'done' && (
        // the tyres of each stint it brought: the app's guess ticked, one tap or "Confirm all" to save them
        <UploadTyres runIds={uploadRunIds(job)} refresh={settled} />
      )}
      {job && !running && made?.order.map((id) => {
        if (settled[id]) return <SettledLine key={id} s={settled[id]} />;
        const ev = made.events.find((e) => e.id === id);
        return ev ? <NameNewEvent key={id} ev={ev} onSettled={(s) => settle(id, s)} /> : null;
      })}
      {job && !running && job.session_ids.length > 0 && (
        // which season the upload's events are in: joined by itself, or asked (what they were run with comes from it)
        <SeasonMatch runIds={job.session_ids} onChanged={() => { setSettled((s) => ({ ...s })); onProgress(); }} />
      )}
      {job && !running && landed && !into && (
        <TextLink href={{ pathname: '/event/[id]', params: { id: landed.id } }} label={`Open ${landed.name}`} red arrow />
      )}
      {retry && (
        <View accessibilityLiveRegion="polite">
          <Note>
            {`The connection to the server was cut (it may be restarting): sending the files again in ${retry.wait_s} s, try ${retry.attempt} of ${retry.of}.`}
          </Note>
        </View>
      )}
      {resends.current > 0 && sending && (
        <View accessibilityLiveRegion="polite">
          <Note>The server restarted while importing: sending the files again. Logs it already took in are left out.</Note>
        </View>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
    </View>
  );
}

/** On a phone, where nothing can be dropped: the same framed box, a tap opens the file picker. */
function PickBox({ big, busy, onPick, title, progress }: {
  big: boolean;
  busy: boolean;
  onPick: () => void;
  title: string;
  progress: ReactNode;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <Pressable onPress={onPick} disabled={busy} accessibilityRole="button" accessibilityLabel={title}
      style={StyleSheet.flatten([styles.pickBox, big && styles.pickBig, busy && progress ? styles.pickBusy : null])}>
      {busy ? progress ?? <ActivityIndicator color={c.text} /> : (
        <>
          <Text style={styles.pickTitle}>{title}</Text>
          <Text style={styles.pickAction}>Tap to pick the files</Text>
        </>
      )}
    </Pressable>
  );
}

/** How far the upload has got, in one bar: first the files going out (per cent, MB sent of MB), then the server
 * reading them (run 3 of 15, and which), then done or failed; under it, while it goes, the time left. */
function UploadStatus({ sending, job, eta = null }: {
  sending: Sending | null;
  job: ImportJob | null;
  eta?: EtaText | null;
}) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  let step: { block: string; color: string } = { block: '1 · Sending', color: c.rule };
  let label: string;
  let fig: string | null = null;
  let sub: string | null = null;
  let share: number | null = null;
  let failed = false;
  if (sending) {
    share = sending.total ? Math.min(1, sending.loaded / sending.total) : null;
    label = share != null && share >= 1 ? 'Sent: the server is taking it in' : `Sending ${plural(sending.files, 'file')}`;
    fig = share != null ? `${Math.floor(share * 100)}%` : null;
    sub = sending.total ? `${mb(sending.loaded)} MB of ${mb(sending.total)} MB` : 'Sending…';
  } else if (job && (job.status === 'queued' || job.status === 'running')) {
    step = { block: '2 · Processing', color: c.rule };
    if (job.total === 0) {
      label = job.status === 'queued' ? 'Waiting for the server' : 'Unpacking the upload';
      sub = 'Looking for the logs in it';
    } else if (job.current?.startsWith(CHECKING)) { // before reading them, the logs already in the app are found
      label = `Checking ${plural(job.total, 'log')}`;
      sub = shortName(job.current.slice(CHECKING.length));
    } else {
      const at = Math.min(job.done + 1, job.total);
      label = `Processing run ${at} of ${job.total}`;
      fig = `${job.done}/${job.total}`;
      share = job.done / job.total;
      sub = job.current ? shortName(job.current) : null;
    }
  } else if (job) {
    failed = job.status === 'failed';
    const imported = job.session_ids.length;
    step = failed ? { block: 'Failed', color: c.error } : { block: 'Done', color: c.timing.personal };
    label = failed ? 'The import failed' : job.total === 0 ? 'No logs in the upload' : `Imported ${plural(imported, 'run')}`;
    fig = job.total ? `${job.done}/${job.total}` : null;
    share = failed ? (job.total ? job.done / job.total : 0) : 1;
    sub = failed ? job.message : job.errors.length ? `${plural(job.errors.length, 'file')} didn’t import` : 'Every log is in';
  } else {
    return null;
  }
  return (
    <View style={styles.status} accessibilityLiveRegion="polite">
      <View style={styles.statusHead}>
        <Block label={step.block} color={step.color} ink={inkOn(step.color)} />
        <Text style={wide ? styles.statusLabel : styles.statusLabelPhone} numberOfLines={2}>{label}</Text>
        {fig ? <Text style={wide ? styles.statusFig : styles.statusFigPhone}>{fig}</Text> : null}
      </View>
      <ProgressBar share={share} failed={failed} label={label} />
      {eta ? <EtaLines lines={eta} wide={wide} /> : null}
      {sub ? <Text style={styles.statusSub} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

function Summary({ job, onHide }: { job: ImportJob; onHide: () => void }) {
  const styles = useStyles();
  const byReason = new Map<string, string[]>();
  for (const s of job.skipped.filter((x) => !x.already)) {
    byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), shortName(s.file)]);
  }
  const already = job.skipped.filter((x) => x.already).length;
  const untimed = untimedRuns(job);

  return (
    <View style={styles.summary}>
      {job.status !== 'failed' && job.message && <ErrorLine>{job.message}</ErrorLine>}
      {job.errors.slice(0, 10).map((e, i) => (
        <ErrorLine key={i}>{shortName(e.file)}: {e.error}</ErrorLine>
      ))}
      {job.errors.length > 10 && <ErrorLine>and {job.errors.length - 10} more</ErrorLine>}
      {already > 0 && (
        <Note>{already} already uploaded, skipped · {job.session_ids.length} new added</Note>
      )}
      {[...byReason].map(([reason, names]) => (
        <Note key={reason}>Skipped {plural(names.length, 'file')} ({reason}): {list(names)}</Note>
      ))}
      {untimed.length > 0 && (
        <Text style={styles.warn}>
          Laps not timed, the lap beacon is missing: {list(untimed.map((u) => u.name ?? u.file))}. Open the run to see
          how to time them.
        </Text>
      )}
      <TextLink onPress={onHide} label="Hide" small />
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { gap: 14 },
  form: { marginTop: 8, borderTopWidth: 1, borderColor: c.rule, paddingTop: 10, maxWidth: 640 },

  pickBox: { borderWidth: 3, borderColor: c.rule, paddingVertical: 28, paddingHorizontal: 18, alignItems: 'center',
    justifyContent: 'center', gap: 12, minHeight: 140 },
  pickBig: { minHeight: 300 },
  pickBusy: { alignItems: 'stretch' },
  pickTitle: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 33, textTransform: 'uppercase', textAlign: 'center',
    color: c.text },
  pickAction: { ...Type.link, color: c.text, borderBottomWidth: 2, borderColor: c.mark, paddingBottom: 1 },

  status: { gap: 10, width: '100%', maxWidth: 760, alignSelf: 'center' },
  statusHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusLabel: { ...Type.label, fontFamily: Fonts.label, fontSize: 15, letterSpacing: 1.6, color: c.text, flex: 1 },
  statusLabelPhone: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, letterSpacing: 1.3, color: c.text, flex: 1 },
  statusFig: { fontFamily: Fonts.display, fontSize: 40, lineHeight: 44, fontVariant: ['tabular-nums'], color: c.text },
  statusFigPhone: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 34, fontVariant: ['tabular-nums'], color: c.text },
  statusSub: { fontFamily: Fonts.label, fontSize: 16, letterSpacing: 0.3, fontVariant: ['tabular-nums'], color: c.textSecondary },

  summary: { gap: 6 },
  warn: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.warning },
}));
