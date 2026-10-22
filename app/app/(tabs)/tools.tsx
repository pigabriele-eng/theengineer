import { Href, Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet } from 'react-native';

import { AppearancePicker } from '@/components/AppearancePicker';
import { Colophon, Page, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { Opening } from '@/components/ToolForm';
import { api, ExportSummary } from '@/lib/api';
import { authEnabled, signOut, useAuthSession } from '@/lib/auth';
import { Fonts, themed, Type } from '@/constants/Theme';

type Tool = { href: Href; title: string; blurb: string };

// What is left of the bench while the app is kept to the weekends' analysis (Gabriele, 2026-10-15: "Remove
// everything else for the moment"): the manual, and where the cars, drivers and seasons are kept (they name the runs
// and say who drove them). The tools themselves still open from an old link.
const GROUPS: { name: string; dek: string; tools: Tool[] }[] = [
  {
    name: 'Help',
    dek: 'How the app works, function by function.',
    tools: [
      {
        href: '/manual',
        title: 'Manual',
        blurb: 'Every function in plain words and the taps that reach it, part by part. Type a word to find one. Also at the top of every page.',
      },
    ],
  },
  {
    name: 'Cars and seasons',
    dek: 'Who drives which car, and the season each weekend belongs to: they name the runs and say who drove them.',
    tools: [
      {
        href: '/garage',
        title: 'Cars, drivers and teams',
        blurb: 'Car numbers, vehicles and teams, who drives which car, the logger in each car (runs from a linked logger get their car by themselves), and your tyres with their P-Book pressures.',
      },
      {
        href: '/seasons',
        title: 'Seasons',
        blurb:
          'Make a season for the year: series, our car number and entry (tyre, car, team, drivers 1 to 4). Its ' +
          'rounds come in as planned events, and the official timetable names each run (FP1, Q1, R1 stint 2).',
      },
    ],
  },
];

/** The Settings page (/tools): the manual and the cars and seasons in numbered sections, one ruled line each (its
 * name, what it does, the way in), then the appearance and the account. */
export default function ToolsScreen() {
  return (
    <Page>
      <Opening title="Settings"
        dek="The manual, where the cars, drivers and seasons are kept, the download of your data, and how the app looks." />
      {GROUPS.map((g, i) => (
        <Section key={g.name} no={i + 1} title={g.name} dek={g.dek}>
          <View>
            {g.tools.map((t, k) => <ToolLine key={t.title} tool={t} first={k === 0} />)}
          </View>
        </Section>
      ))}
      <YourData no={GROUPS.length + 1} />
      <AppearancePicker no={GROUPS.length + 2} />
      {authEnabled && <Account no={GROUPS.length + 3} />}
      <Colophon left="The Engineer · Settings" links={[
        { label: 'Tracks', href: '/' },
        { label: 'Garage', href: '/garage' },
        { label: 'Seasons', href: '/seasons' },
      ]} />
    </Page>
  );
}

/** One tool: its name large, what it does, and an arrow; the whole line opens it. */
function ToolLine({ tool, first }: { tool: Tool; first: boolean }) {
  const styles = useStyles();
  const wide = useWide();
  return (
    // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
    <Link href={tool.href} asChild>
      <Pressable accessibilityRole="link" accessibilityLabel={`${tool.title}: ${tool.blurb}`}
        style={StyleSheet.flatten([wide ? styles.line : styles.linePhone, first && styles.lineFirst])}>
        <Text style={wide ? styles.name : styles.namePhone}>{tool.title}</Text>
        <Text style={wide ? styles.blurb : styles.blurbPhone}>{tool.blurb}</Text>
        <Text style={wide ? styles.arrow : styles.arrowPhone}>Open →</Text>
      </Pressable>
    </Link>
  );
}

const size = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`);

async function download(eventId?: number) {
  const url = await api.exportUrl(eventId);
  if (Platform.OS === 'web') window.open(url, '_blank');
  else Linking.openURL(url);
}

/** Everything uploaded, as one zip (Gabriele, 2026-10-22: "create a link for me to download ALL data i uploaded to
 * The Engineer to date"): the logs as uploaded, the debrief recordings, and what was set in the app; or one event's,
 * for the days Backblaze's free download limit stops a big download half way (MISSING.txt in the zip says so). */
function YourData({ no }: { no: number }) {
  const styles = useStyles();
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api.exportEvents().then(setSummary).catch((e) => setError(String(e.message ?? e)));
  }, []);
  return (
    <Section no={no} title="Your data"
      dek="Download every log you uploaded, as uploaded, with the debrief recordings and the names, drivers and tyres you set.">
      <View style={styles.account}>
        <View style={styles.accountWho}>
          <Text style={styles.signedIn}>Everything</Text>
          <Text style={styles.email}>
            {error ?? (summary ? `${summary.files} files · about ${size(summary.mb)}` : 'Counting the files…')}
          </Text>
        </View>
        <TextLink onPress={() => download()} label="Download everything" red />
      </View>
      <Text style={styles.dataNote}>
        One zip, folders by track, event and run. Unzip it and press Import folder in the desktop app. If a file
        can't be read today (Backblaze's free daily download limit), the zip lists it in MISSING.txt: download that
        event again after 2 am.
      </Text>
      {summary && summary.events.length > 0 && (
        <TextLink onPress={() => setOpen(!open)} label={open ? 'Hide the events' : 'One event at a time'} small />
      )}
      {open && summary?.events.map((e) => (
        <View key={e.id} style={styles.dataRow}>
          <View style={styles.accountWho}>
            <Text style={styles.dataName}>{e.track ? `${e.track} · ${e.name}` : e.name}</Text>
            <Text style={styles.dataNote}>{e.runs} {e.runs === 1 ? 'run' : 'runs'} · {size(e.mb)}</Text>
          </View>
          <TextLink onPress={() => download(e.id)} label="Download" small />
        </View>
      ))}
    </Section>
  );
}

function Account({ no }: { no: number }) {
  const styles = useStyles();
  const { session } = useAuthSession();
  return (
    <Section no={no} title="Account" dek="Who this device is signed in as.">
      <View style={styles.account}>
        <View style={styles.accountWho}>
          <Text style={styles.signedIn}>Signed in</Text>
          <Text style={styles.email}>{session?.user.email}</Text>
        </View>
        <TextLink onPress={() => signOut()} label="Sign out" red />
      </View>
    </Section>
  );
}

const NAME_W = 300;

const useStyles = themed((c) => ({
  line: { flexDirection: 'row', alignItems: 'baseline', gap: 26, borderBottomWidth: 1, borderColor: c.rule, paddingTop: 15,
    paddingBottom: 14 },
  linePhone: { flexDirection: 'column', gap: 6, borderBottomWidth: 1, borderColor: c.rule, paddingTop: 13, paddingBottom: 12 },
  lineFirst: { borderTopWidth: 1 },
  name: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, textTransform: 'uppercase', width: NAME_W, color: c.text },
  namePhone: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 28, textTransform: 'uppercase', color: c.text },
  blurb: { flex: 1, fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.textSecondary },
  blurbPhone: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.textSecondary },
  arrow: { ...Type.link, fontSize: 13, color: c.text, borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 1 },
  arrowPhone: { ...Type.link, fontSize: 12, alignSelf: 'flex-start', color: c.text, borderBottomWidth: 2, borderColor: c.rule,
    paddingBottom: 1, marginTop: 4 },
  account: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16,
    borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.rule, paddingVertical: 14 },
  accountWho: { flexShrink: 1 },
  signedIn: { ...Type.label, color: c.textSecondary },
  email: { fontFamily: Fonts.label, fontSize: 18, color: c.text, marginTop: 4 },
  dataNote: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.textSecondary, marginVertical: 10 },
  dataRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    borderBottomWidth: 1, borderColor: c.rule, paddingVertical: 8 },
  dataName: { fontFamily: Fonts.label, fontSize: 17, color: c.text },
}));
