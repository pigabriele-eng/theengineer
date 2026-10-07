import { useLocalSearchParams } from 'expo-router';

import EventReport from '@/components/report/EventReport';

/** The report page (?event= for a whole event, ?event=&part= for one official session of it, "FP1", ?session= for one
 * run): the report as a page of its own, with the hero, the switcher and Print to PDF (components/report/EventReport.tsx,
 * also the race weekend's After tab). */
export default function ReportScreen() {
  const params = useLocalSearchParams<{ event?: string; part?: string; session?: string }>();
  return (
    <EventReport eventId={params.event ? Number(params.event) : undefined} part={params.part || undefined}
      sessionId={params.session ? Number(params.session) : undefined} />
  );
}
