// Setup changes to try for one run, from what the driver said and what the data show: the Suggestions tab of the setup
// page (app/tools/setup.tsx), and the race weekend page's Setup suggestions for the latest run.
import { ReactNode, useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Block, Label, Section, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { ErrorLine, Note, SubHead, Working } from '@/components/ToolForm';
import { Observation, setupApi, Suggestion, Suggestions } from '@/lib/setup';
import { face, Fonts, inkOn, themed, Type, useTheme } from '@/constants/Theme';

/** A numbered section of its own (the setup page), or a part under a sub-head inside the page's section (`parts`). */
function Part({ parts, no, title, dek, children }: { parts: boolean; no: number; title: string; dek: string;
  children: ReactNode }) {
  const styles = useStyles();
  if (!parts) return <Section no={no} title={title} dek={dek}>{children}</Section>;
  return (
    <View style={styles.part}>
      <SubHead>{title}</SubHead>
      {children}
    </View>
  );
}

/** Ranked setup changes to try, then what the driver said and what the data show, for one run. `no`: the number of
 * its first section; `parts`: under sub-heads instead, inside a section of the page that shows it. */
export function IdeasView({ sessionId, vehicleId, no: first = 2, parts = false }: { sessionId: number;
  vehicleId: number | null; no?: number; parts?: boolean }) {
  const styles = useStyles();
  const wide = useWide();
  const [data, setData] = useState<Suggestions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    setupApi.suggestions(sessionId, vehicleId).then(
      (s) => live && setData(s),
      (e) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [sessionId, vehicleId]);

  const dek = 'Best first, in one list from what the driver said and what the balance report reads in this run’s log. Each says why, what to expect and what to watch, and where the driver and the data disagree. Change one thing at a time.';
  if (error || !data) {
    return (
      <Part parts={parts} no={first} title="Setup changes to try" dek={dek}>
        {error ? <ErrorLine>{error}</ErrorLine> : <Working>Reading the debrief and the data…</Working>}
      </Part>
    );
  }
  const said = data.observations.filter((o) => o.source === 'driver');
  const other = data.observations.filter((o) => o.source !== 'driver');
  let no = first;
  return (
    <>
      <Part parts={parts} no={no} title="Setup changes to try" dek={dek}>
        {data.data?.headline ? (
          <View style={styles.headline}>
            <Label small>From the data</Label>
            <Text style={wide ? styles.headlineText : styles.headlineTextPhone}>{data.data.headline}</Text>
            {data.data.notes.map((n) => <Note key={n} small>{n}</Note>)}
          </View>
        ) : null}
        {data.notes.map((n) => <Note key={n} small style={styles.gapTop}>{n}</Note>)}
        {data.suggestions.length === 0 && (data.observations.length > 0 || data.data) && (
          <Note style={styles.gapTop}>Nothing in the feedback or the data points clearly to a setup change.</Note>
        )}
        {data.suggestions.length === 0 && data.observations.length === 0 && !data.data && parts && (
          <Note style={styles.gapTop}>No debrief and no balance reading for this run yet.</Note>
        )}
        {data.suggestions.map((s) => <Idea key={s.lever} s={s} />)}
      </Part>
      {said.length > 0 && (
        <Part parts={parts} no={++no} title="What the driver said" dek="Each remark, and what the data make of it.">
          {said.map((o, i) => (
            <View key={i} style={styles.obs}>
              <Text style={styles.obsLabel}>
                {o.label}
                {o.speed && o.corner ? ` (${o.speed} corner)` : ''}
              </Text>
              <Text style={styles.quote}>“{o.text}”</Text>
              {o.check ? (
                <Text style={o.check.verdict === 'disagree' ? styles.checkWarn : styles.check}>
                  <Text style={styles.checkLabel}>Data: </Text>
                  {VERDICT[o.check.verdict]}. {o.check.text}
                </Text>
              ) : null}
            </View>
          ))}
          {data.skipped_points.length > 0 && (
            <Note small style={styles.gapTop}>
              {data.skipped_points.length} other debrief point{data.skipped_points.length > 1 ? 's' : ''} had nothing
              for the setup.
            </Note>
          )}
        </Part>
      )}
      {data.measured.length + other.length > 0 && (
        <Part parts={parts} no={++no} title="What the data show"
          dek="Each corner’s balance against the car’s normal where it is clear (0.8° or more), and where traction control or rear wheel slip says the rear can’t take the power.">
          {[...data.measured, ...other].map((o, i) => (
            <Text key={i} style={StyleSheet.flatten([styles.measured, i === 0 && styles.measuredFirst])}>{o.text || o.label}</Text>
          ))}
        </Part>
      )}
    </>
  );
}

/** One suggestion: its rank in an ink block, the change in Anton, the levers, then why, what to expect and what to
 * watch. */
function Idea({ s }: { s: Suggestion }) {
  const c = useTheme();
  const styles = useStyles();
  const wide = useWide();
  const tone = s.agreement === 'disagree' ? c.warning : s.agreement === 'both' ? c.rule : c.band;
  return (
    <View style={styles.idea}>
      <View style={styles.ideaHead}>
        <View style={styles.rank}><Text style={styles.rankText}>{s.rank}</Text></View>
        <View style={styles.ideaWords}>
          <Text style={wide ? styles.ideaTitle : styles.ideaTitlePhone}>{s.title}</Text>
          <Block label={AGREEMENT[s.agreement]} color={tone} ink={tone === c.band ? c.text : inkOn(tone)} style={styles.agree} />
        </View>
      </View>
      {s.changes.map((ch) => <Text key={ch.key} style={styles.changeText}>{ch.text}</Text>)}
      <View style={styles.ideaBody}>
        {s.reason ? <Line label="Why">{s.reason}</Line> : null}
        {s.report ? (
          <Line label={`Balance report’s no. ${s.report.rank}`}>{s.report.why}</Line>
        ) : s.data_shows ? (
          <Line label="The data shows">{s.data_shows}</Line>
        ) : null}
        {s.confirmed.length > 0 && <Line label="The data agrees">{s.confirmed.join(' ')}</Line>}
        {s.disagree.map((t) => <Line key={t} label="Disagree" warn>{t}</Line>)}
        <Line label="Expect">{s.expected}{s.model ? ` ${s.model}` : ''}</Line>
        {s.watch ? <Line label="Watch">{s.watch}</Line> : null}
      </View>
    </View>
  );
}

function Line({ label, children, warn }: { label: string; children: ReactNode; warn?: boolean }) {
  const styles = useStyles();
  return (
    <Text style={warn ? styles.lineWarn : styles.line}>
      <Text style={warn ? styles.lineLabelWarn : styles.lineLabel}>{`${label}  `}</Text>
      {children}
    </Text>
  );
}

const AGREEMENT: Record<Suggestion['agreement'], string> = {
  both: 'Driver + data agree',
  driver: 'Driver',
  data: 'Data',
  disagree: 'Driver and data disagree',
};

const VERDICT: Record<NonNullable<Observation['check']>['verdict'], string> = {
  agree: 'agrees',
  slight: 'leans the same way',
  normal: 'reads normal',
  disagree: 'says the opposite',
  unmeasured: 'not measured',
};

const useStyles = themed((c) => ({
  gapTop: { marginTop: 12 },
  part: { marginTop: 22 },
  changeText: { fontFamily: Type.label.fontFamily, fontSize: 15, lineHeight: 21, color: c.text },
  headline: { gap: 6, borderLeftWidth: 6, borderColor: c.rule, paddingLeft: 14, marginBottom: 10 },
  headlineText: { fontFamily: face('body', 500), fontSize: 22, lineHeight: 31, color: c.text, maxWidth: 820 },
  headlineTextPhone: { fontFamily: face('body', 500), fontSize: 19, lineHeight: 27, color: c.text },
  idea: { borderTopWidth: 3, borderColor: c.rule, paddingTop: 12, marginTop: 22, gap: 6 },
  ideaHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rank: { backgroundColor: c.rule, paddingHorizontal: 9, paddingTop: 4, paddingBottom: 3, minWidth: 34, alignItems: 'center' },
  rankText: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 28, color: c.background },
  ideaWords: { flex: 1, minWidth: 0, gap: 6 },
  ideaTitle: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, textTransform: 'uppercase', color: c.text },
  ideaTitlePhone: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 27, textTransform: 'uppercase', color: c.text },
  agree: { marginBottom: 2 },
  ideaBody: { gap: 6, marginTop: 4, maxWidth: 820 },
  line: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text },
  lineWarn: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.warning },
  lineLabel: { ...Type.label, fontSize: 12, color: c.text },
  lineLabelWarn: { ...Type.label, fontSize: 12, color: c.warning },
  obs: { borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 10, gap: 3 },
  obsLabel: { fontFamily: Type.label.fontFamily, fontSize: 15, color: c.text },
  quote: { fontFamily: Type.dek.fontFamily, fontSize: 16, lineHeight: 23, color: c.textSecondary },
  check: { fontFamily: Fonts.body, fontSize: 14, lineHeight: 20, color: c.text },
  checkWarn: { fontFamily: Fonts.body, fontSize: 14, lineHeight: 20, color: c.warning },
  checkLabel: { ...Type.label, fontSize: 11 },
  measured: { fontFamily: Fonts.label, fontSize: 15, lineHeight: 21, fontVariant: ['tabular-nums'], color: c.text,
    borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 7 },
  measuredFirst: { borderTopWidth: 2, borderTopColor: c.rule },
}));
