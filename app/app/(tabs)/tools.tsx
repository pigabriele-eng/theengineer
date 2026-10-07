import { Href, Link } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { AppearancePicker } from '@/components/AppearancePicker';
import { Colophon, Page, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { Opening } from '@/components/ToolForm';
import { authEnabled, signOut, useAuthSession } from '@/lib/auth';
import { Fonts, themed, Type } from '@/constants/Theme';

type Tool = { href: Href; title: string; blurb: string };

const GROUPS: { name: string; dek: string; tools: Tool[] }[] = [
  {
    name: 'Tyres',
    dek: 'What to set cold, what the temperatures across the tread say, and where the grip is.',
    tools: [
      {
        href: '/tools/pressures',
        title: 'Pressure calculator',
        blurb: 'Cold pressures for a hot target, corrected for ambient and track temperature. Flags anything below the minimums.',
      },
      {
        href: '/tools/tyre-temps',
        title: 'Tyre temperatures',
        blurb: 'Pyrometer inside, middle and outside readings or IR logs, turned into camber and pressure suggestions.',
      },
      {
        href: '/tools/tyre-fit',
        title: 'Tyre fit',
        blurb:
          'Tyre curve per axle from one log, or built up from every log of the car: where grip peaks, and which ' +
          'TPMS temperature and hot pressure give the most.',
      },
    ],
  },
  {
    name: 'Setup',
    dek: 'A sheet per run, and what each change did.',
    tools: [
      {
        href: '/tools/setup',
        title: 'Setup',
        blurb: 'A setup sheet per run for the M4 GT4 EVO, copied from the last run. What changed against lap time and balance, and setup changes to try from the debrief and the data.',
      },
    ],
  },
  {
    name: 'Car',
    dek: 'The cars, who drives them, and how they behave on their springs.',
    tools: [
      {
        href: '/garage',
        title: 'Cars, drivers and teams',
        blurb: 'Car numbers, vehicles and teams, who drives which car, the logger in each car (runs from a linked logger get their car by themselves), and your tyres with their P-Book pressures.',
      },
      {
        href: '/tools/vehicle',
        title: 'Vehicle model',
        blurb: 'Weight transfer, roll stiffness split and ride frequencies from springs, bars and motion ratios. Try a change and see the balance shift.',
      },
    ],
  },
  {
    name: 'Drivers and laps',
    dek: 'Every driver and every lap, across events.',
    tools: [
      {
        href: '/drivers/fingerprints',
        title: 'Driver fingerprints',
        blurb: 'Each driver’s driving style from their laps, which traits go with faster laps, and who drove a run nobody tagged.',
      },
      {
        href: '/drivers/habits',
        title: 'Driver habits',
        blurb: 'Each driver’s recurring mistakes over every event, getting better or worse, and two drivers side by side.',
      },
      {
        href: '/compare',
        title: 'Compare laps',
        blurb: 'Any two to six laps from any sessions at one track, on one line: where the time is and why.',
      },
      {
        href: '/drivers/compare',
        title: 'Compare drivers',
        blurb: 'Two drivers over many runs at one track: who gains where, and the technique behind it.',
      },
      {
        href: '/drivers/tag',
        title: 'Tag drivers',
        blurb: 'Say who drove each run, event by event.',
      },
    ],
  },
  {
    name: 'Events',
    dek: 'The season and the weekends to come.',
    tools: [
      {
        href: '/tools/calendar',
        title: 'Racing calendar',
        blurb: 'Bring in your tests and race weekends from Google Calendar as planned events, and pick which ones.',
      },
      {
        href: '/seasons',
        title: 'Seasons',
        blurb:
          'Make a season for the year: series, our car number and entry (tyre, car, team, drivers 1 to 4). Its ' +
          'rounds come in as planned events, with dates and entry lists from the series’ site when it has them.',
      },
    ],
  },
  {
    name: 'Logger data',
    dek: 'A stint read from the logger’s own export.',
    tools: [
      {
        href: '/tools/stint',
        title: 'Stint analysis',
        blurb: 'Balance through each corner phase, grip lap by lap and degradation over a stint. Works with MoTeC, AiM and Cosworth CSV exports.',
      },
    ],
  },
];

/** The Tools page: the engineering tools in numbered sections, one ruled line each (its name, what it does, the way
 * in), then the appearance and the account. */
export default function ToolsScreen() {
  return (
    <Page>
      <Opening title="Tools"
        dek="The engineer’s bench: tyre pressures and temperatures, the tyre model, the setup sheet and the vehicle model, and where the cars, seasons and calendar are kept." />
      {GROUPS.map((g, i) => (
        <Section key={g.name} no={i + 1} title={g.name} dek={g.dek}>
          <View>
            {g.tools.map((t, k) => <ToolLine key={t.title} tool={t} first={k === 0} />)}
          </View>
        </Section>
      ))}
      <AppearancePicker no={GROUPS.length + 1} />
      {authEnabled && <Account no={GROUPS.length + 2} />}
      <Colophon left="The Engineer · Tools" links={[
        { label: 'Weekend', href: '/' },
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
}));
