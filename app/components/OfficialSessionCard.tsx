import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import {
  OfficialSession,
  OurResult,
  percent,
  plusSeconds,
  raceGap,
  resultsApi,
  RunResult,
  startLabel,
  STATUS_NAMES,
  weatherLabel,
} from '@/lib/results';
import { inkOn, Radius, themed, useTheme } from '@/constants/Theme';


/** One official session at a glance: where our car finished (overall and in class), the gaps, our best lap against
 * the fastest, the class and our make, the weather, what our logged best lap would have been worth, and our logged
 * sessions in it. The makes table opens on a tap. `current` hides the link to the session already open. */
export function OfficialSessionCard({ s, current }: { s: OfficialSession; current?: number }) {
  const styles = useStyles();
  const tint = useThemeColor({}, 'tint');
  const [makes, setMakes] = useState(false);
  const race = s.kind === 'race';
  const head = [s.title, startLabel(s.starts_at), `${s.cars} cars`].filter(Boolean).join(' · ');
  const weather = weatherLabel(s.weather);
  const ours = s.our_sessions.filter((o) => o.id !== current);
  const fastest = s.fastest_s != null
    ? `${race ? 'Fastest lap' : 'Pole'} ${formatLap(s.fastest_s)}${s.fastest_car ? ` ${s.fastest_car}` : ''}`
    : s.fastest || null;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{head}</Text>
      {s.us ? <Ours us={s.us} race={race} s={s} /> : fastest && <Text style={styles.line}>{fastest}</Text>}
      {s.logged_best_s != null && (
        <Text style={styles.line}>
          Your logged best {formatLap(s.logged_best_s)}
          {s.logged_rank != null ? ` would be P${s.logged_rank}` : ''}
        </Text>
      )}
      {weather && <Text style={styles.small}>{weather}</Text>}
      {ours.length > 0 && (
        <View style={styles.links}>
          <Text style={styles.small}>Our {ours.length === 1 ? 'session' : 'sessions'}:</Text>
          {ours.map((o) => (
            <Link key={o.id} href={{ pathname: '/session/[id]', params: { id: o.id } }} asChild>
              <Pressable accessibilityRole="link" hitSlop={6}>
                <Text style={StyleSheet.flatten([styles.link, { color: tint }])}>{o.name}</Text>
              </Pressable>
            </Link>
          ))}
        </View>
      )}
      <View style={styles.links}>
        {s.brands.length > 0 && (
          <Pressable onPress={() => setMakes(!makes)} accessibilityRole="button" hitSlop={6}>
            <Text style={StyleSheet.flatten([styles.link, { color: tint }])}>{makes ? '▾' : '▸'} Makes</Text>
          </Pressable>
        )}
        {!!s.source_url && (
          <Pressable onPress={() => Linking.openURL(s.source_url)} accessibilityRole="link" hitSlop={6}>
            <Text style={StyleSheet.flatten([styles.link, { color: tint }])}>Official sheet (PDF)</Text>
          </Pressable>
        )}
      </View>
      {makes && <Makes s={s} ourBrand={s.us?.brand} />}
    </View>
  );
}

function Ours({ us, race, s }: { us: OurResult; race: boolean; s: OfficialSession }) {
  const theme = useTheme();
  const styles = useStyles();
  const out = us.status !== 'classified';
  const place = us.position != null ? `P${us.position} overall` : null;
  const inClass = us.class_position != null
    ? `P${us.class_position}${us.class_cars ? ` of ${us.class_cars}` : ''} ${us.car_class}`
    : null;
  const leader = race ? raceGap(us.gap_to_leader_s, us.gap_to_leader_laps) : plusSeconds(us.gap_to_leader_s);
  const ahead = race ? raceGap(us.gap_to_ahead_s, null) : plusSeconds(us.gap_to_ahead_s);
  const gaps = [
    leader && us.position !== 1 ? `${leader} to the leader` : null,
    ahead && us.position !== 1 ? `${ahead} to the car ahead` : null,
    race && us.laps ? `${us.laps} laps` : null,
  ].filter(Boolean).join(' · ');
  const toFastest = [plusSeconds(us.to_fastest_s), percent(us.to_fastest_pct)].filter(Boolean).join(' / ');
  const best = us.best_lap_s != null
    ? `Best ${formatLap(us.best_lap_s)}${toFastest && us.to_fastest_s ? `, ${toFastest} to ${race ? 'the fastest lap' : 'pole'}${s.fastest_car ? ` ${s.fastest_car}` : ''}` : ''}${race && us.best_lap_rank != null ? ` (${ordinal(us.best_lap_rank)} quickest)` : ''}`
    : null;
  const classBest = us.class_best_s != null && us.class_best_s !== us.best_lap_s
    ? `${us.car_class} best ${formatLap(us.class_best_s)}${us.to_class_best_s != null ? ` (${plusSeconds(us.to_class_best_s)})` : ''}`
    : null;
  const brandBest = us.brand_best_s != null
    ? `Best other ${us.brand} ${formatLap(us.brand_best_s)}${us.brand_best_car ? ` ${us.brand_best_car}` : ''}`
    : null;

  return (
    <View style={styles.us}>
      <View style={styles.placeRow}>
        {out && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{us.status.toUpperCase()}</Text>
          </View>
        )}
        <Text style={styles.place}>
          {[place, inClass].filter(Boolean).join(', ') || STATUS_NAMES[us.status]}
        </Text>
      </View>
      {out && <Text style={StyleSheet.flatten([styles.small, { color: theme.error, opacity: 1 }])}>{STATUS_NAMES[us.status]}</Text>}
      {!!gaps && <Text style={styles.line}>{gaps}</Text>}
      {best && <Text style={styles.line}>{best}</Text>}
      {(classBest || brandBest) && (
        <Text style={styles.small}>{[classBest, brandBest].filter(Boolean).join(' · ')}</Text>
      )}
    </View>
  );
}

function Makes({ s, ourBrand }: { s: OfficialSession; ourBrand?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.table}>
      <View style={styles.tr}>
        <Text style={[styles.th, styles.cBrand]}>Make</Text>
        <Text style={[styles.th, styles.cNum]}>Best lap</Text>
        <Text style={[styles.th, styles.cNum]}>To fastest</Text>
        <Text style={[styles.th, styles.cNum]}>Best place</Text>
      </View>
      {s.brands.map((b) => (
        <View key={b.brand} style={styles.tr}>
          <Text style={[styles.td, styles.cBrand, b.brand === ourBrand && styles.bold]} numberOfLines={1}>
            {b.brand} <Text style={styles.small}>×{b.cars}</Text>
          </Text>
          <Text style={[styles.td, styles.cNum]}>{formatLap(b.best_s)}</Text>
          <Text style={[styles.td, styles.cNum]}>{b.to_fastest_pct ? percent(b.to_fastest_pct) : '–'}</Text>
          <Text style={[styles.td, styles.cNum]}>{b.best_position != null ? `P${b.best_position}` : '–'}</Text>
        </View>
      ))}
    </View>
  );
}

const ordinal = (n: number) => {
  const t = n % 100;
  const suffix = t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
};

const useStyles = themed((c) => ({
  card: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.card, padding: 12, gap: 4, backgroundColor: c.surface },
  title: { fontSize: 15, fontWeight: '700' },
  us: { gap: 2, backgroundColor: 'transparent' },
  placeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', backgroundColor: 'transparent' },
  place: { fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  badge: { backgroundColor: c.status.critical, borderRadius: Radius.tag, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { color: inkOn(c.status.critical), fontWeight: '800', fontSize: 12 },
  line: { fontSize: 14, fontVariant: ['tabular-nums'] },
  small: { fontSize: 12, opacity: 0.6, fontVariant: ['tabular-nums'] },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 4,
    backgroundColor: 'transparent' },
  link: { fontSize: 14, fontWeight: '600' },
  table: { marginTop: 4, backgroundColor: 'transparent' },
  tr: { flexDirection: 'row', paddingVertical: 3, borderBottomWidth: 1, borderColor: c.separator,
    backgroundColor: 'transparent' },
  th: { fontSize: 11, fontWeight: '700', opacity: 0.6, textTransform: 'uppercase' },
  td: { fontSize: 13, fontVariant: ['tabular-nums'] },
  cBrand: { flex: 1.4 },
  cNum: { flex: 1, textAlign: 'right' },
  bold: { fontWeight: '700' },
  session: { gap: 8, backgroundColor: 'transparent' },
  h2: { fontSize: 18, fontWeight: '700' },
}));

/** On a session's page: the official session this run was part of, or nothing (the server's note, small, when
 * it has one). */
export function SessionResults({ sessionId }: { sessionId: number }) {
  const styles = useStyles();
  const [run, setRun] = useState<RunResult | null>(null);
  useEffect(() => {
    let alive = true;
    setRun(null);
    resultsApi.run(sessionId).then(
      (r) => alive && setRun(r),
      () => alive && setRun(null), // no results (or no server for them yet): show nothing
    );
    return () => {
      alive = false;
    };
  }, [sessionId]);
  if (!run) return null;
  if (!run.official) return run.note ? <Text style={styles.small}>{run.note}</Text> : null;
  return (
    <View style={styles.session}>
      <Text style={styles.h2}>Official result</Text>
      <OfficialSessionCard s={run.official} current={sessionId} />
    </View>
  );
}
