// Upload many logger files at once (MoTeC .ld with their .ldx, CSV exports, zips of whole tests) and follow the
// import: the server makes a session per log in the background.
import * as DocumentPicker from 'expo-document-picker';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { api, ImportJob } from '@/lib/api';

// The browser's file dialog filters by extension. iOS and Android filter by MIME type only, and a .ld log has
// none, so there every file can be picked and the server skips what isn't a log.
const ACCEPT = Platform.OS === 'web' ? ['.zip', '.ld', '.ldx', '.csv', '.txt'] : ['*/*'];
const POLL_MS = 1500;
const MAX_POLL_FAILURES = 20; // about half a minute without an answer
const LISTED = 5; // names shown per group before "and N more"

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
// "02_ADACGT4_T01_HOC.zip/02_ADACGT4_T01_HOC/01_D1S1/a.ld" -> "01_D1S1/a.ld"
const shortName = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/');
const list = (names: string[]) =>
  names.slice(0, LISTED).join(', ') + (names.length > LISTED ? ` and ${names.length - LISTED} more` : '');

export function ImportLogs({ onProgress }: { onProgress: () => void }) {
  const [uploading, setUploading] = useState<number | null>(null); // how many files are being sent
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failures = useRef(0);
  const tint = useThemeColor({}, 'tint');
  const running = job != null && (job.status === 'queued' || job.status === 'running');

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

  const pick = async () => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ACCEPT,
      multiple: true,
      copyToCacheDirectory: true,
      base64: false,
    });
    if (picked.canceled || !picked.assets?.length) return;
    setError(null);
    setJob(null);
    setUploading(picked.assets.length);
    try {
      failures.current = 0;
      setJob(
        await api.importFiles(
          picked.assets.map((a) => ({ uri: a.uri, name: a.name, file: a.file, mimeType: a.mimeType })),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(null);
    }
  };

  const busy = uploading != null || running;
  return (
    <View style={styles.box}>
      <Pressable style={[styles.button, { borderColor: tint }]} onPress={pick} disabled={busy}>
        {busy ? (
          <ActivityIndicator color={tint} />
        ) : (
          <Text style={[styles.buttonText, { color: tint }]}>Upload logs or a zip</Text>
        )}
      </Pressable>
      {uploading != null && <Text style={styles.sub}>Uploading {plural(uploading, 'file')}…</Text>}
      {job && running && <Progress job={job} />}
      {job && !running && <Summary job={job} onHide={() => setJob(null)} tint={tint} />}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

function Progress({ job }: { job: ImportJob }) {
  if (job.total === 0) return <Text style={styles.sub}>Unpacking the upload…</Text>;
  return (
    <Text style={styles.sub}>
      Importing {Math.min(job.done + 1, job.total)} of {plural(job.total, 'run')}…
      {job.current ? ` ${shortName(job.current)}` : ''}
    </Text>
  );
}

function Summary({ job, onHide, tint }: { job: ImportJob; onHide: () => void; tint: string }) {
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
      <Pressable onPress={onHide} hitSlop={8}>
        <Text style={{ color: tint }}>Hide</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6 },
  button: { borderWidth: 1, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  buttonText: { fontWeight: '600', fontSize: 16 },
  summary: { gap: 4 },
  headline: { fontWeight: '600' },
  sub: { opacity: 0.7 },
  error: { color: '#c8372d' },
});
