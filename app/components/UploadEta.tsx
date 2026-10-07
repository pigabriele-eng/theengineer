// The time left of an upload, under its progress bar (components/ImportLogs.tsx): the whole upload ("About 2 min
// left") and the stage it is at ("Sending: about 40 s left"). The estimate is lib/uploadEta.ts; this follows the upload
// and the import job and asks it again every second.
import { useEffect, useRef, useState } from 'react';

import { Text, View } from '@/components/Themed';
import { Fonts, themed } from '@/constants/Theme';
import { importRates, JobWithEta } from '@/lib/importRates';
import { etaLines, UploadEta } from '@/lib/uploadEta';

export type EtaText = { total: string; stage: string };

const TICK_MS = 1000;

/** The two lines to show while an upload is sent or imported, null otherwise. */
export function useUploadEta(sending: { loaded: number; total: number; zipBytes: number } | null,
  job: JobWithEta | null): EtaText | null {
  const eta = useRef<UploadEta | null>(null);
  const [lines, setLines] = useState<EtaText | null>(null);
  const running = job != null && (job.status === 'queued' || job.status === 'running');
  const active = sending != null || running;

  const start = () => {
    if (eta.current) return eta.current;
    const e = new UploadEta();
    eta.current = e;
    importRates().then((r) => e.setRates(r)); // the server's own pace, while the guesses stand in
    return e;
  };
  const show = () => {
    const e = eta.current;
    if (!e) return;
    const now = e.at(Date.now());
    setLines(etaLines(now.stage, now.stage_s, now.total_s));
  };

  useEffect(() => {
    if (sending) start().sent(sending.loaded, sending.total, sending.zipBytes, Date.now());
  }, [sending]);
  const heard = useRef<JobWithEta['eta']>(undefined);
  useEffect(() => {
    // a poll that failed keeps the job it had (ImportLogs asks again): its figure is not news, and not taken as now
    if (!running || job.eta === heard.current) return;
    heard.current = job.eta;
    start().job(job.eta, Date.now());
    show();
  }, [job, running]);
  useEffect(() => {
    if (!active) {
      eta.current = null; // the next upload starts afresh
      setLines(null);
      return;
    }
    show();
    const timer = setInterval(show, TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return active ? lines : null;
}

export function EtaLines({ lines, wide }: { lines: EtaText; wide: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.box}>
      <Text style={wide ? styles.total : styles.totalPhone}>{lines.total}</Text>
      <Text style={styles.stage}>{lines.stage}</Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { gap: 2 },
  total: { fontFamily: Fonts.label, fontSize: 22, lineHeight: 28, fontVariant: ['tabular-nums'], color: c.text },
  totalPhone: { fontFamily: Fonts.label, fontSize: 19, lineHeight: 25, fontVariant: ['tabular-nums'], color: c.text },
  stage: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 23, color: c.textSecondary },
}));
