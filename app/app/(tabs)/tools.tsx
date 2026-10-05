import { Href, Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { authEnabled, signOut, useAuthSession } from '@/lib/auth';

type Tool = { href: Href; title: string; blurb: string };

const GROUPS: { name: string; tools: Tool[] }[] = [
  {
    name: 'Tyres',
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
        blurb: 'A simple tyre curve fitted from logged lateral g, slip or steering and yaw, and load.',
      },
    ],
  },
  {
    name: 'Setup',
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
    tools: [
      {
        href: '/tools/vehicle',
        title: 'Vehicle model',
        blurb: 'Weight transfer, roll stiffness split and ride frequencies from springs, bars and motion ratios. Try a change and see the balance shift.',
      },
    ],
  },
  {
    name: 'Logger data',
    tools: [
      {
        href: '/tools/stint',
        title: 'Stint analysis',
        blurb: 'Balance through each corner phase, grip lap by lap and degradation over a stint. Works with MoTeC, AiM and Cosworth CSV exports.',
      },
    ],
  },
];

export default function ToolsScreen() {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      {GROUPS.map((g) => (
        <View key={g.name} style={styles.group}>
          <Text style={styles.groupName}>{g.name}</Text>
          {g.tools.map((t) => (
            <Link key={t.title} href={t.href} asChild>
              <Pressable style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.title}>{t.title}</Text>
                  <Text style={styles.blurb}>{t.blurb}</Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            </Link>
          ))}
        </View>
      ))}
      {authEnabled && <Account />}
    </ScrollView>
  );
}

function Account() {
  const { session } = useAuthSession();
  const tint = useThemeColor({}, 'tint');
  return (
    <View style={styles.group}>
      <Text style={styles.groupName}>Account</Text>
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.title}>Signed in</Text>
          <Text style={styles.blurb}>{session?.user.email}</Text>
        </View>
        <Pressable onPress={() => signOut()} accessibilityRole="button" hitSlop={8}>
          <Text style={[styles.signOut, { color: tint }]}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 20 },
  group: { gap: 4 },
  groupName: { fontSize: 13, fontWeight: '600', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderColor: '#8882' },
  rowText: { flex: 1, backgroundColor: 'transparent', gap: 2 },
  title: { fontSize: 16, fontWeight: '600' },
  blurb: { opacity: 0.6, lineHeight: 19 },
  chevron: { fontSize: 24, opacity: 0.4, paddingLeft: 8 },
  signOut: { fontSize: 16, fontWeight: '600', paddingLeft: 8 },
});
