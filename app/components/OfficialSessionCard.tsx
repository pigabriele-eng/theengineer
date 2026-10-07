import { useEffect, useState } from 'react';
import { Linking, StyleSheet } from 'react-native';

import { onFill, SubHead, usePrepType } from '@/components/PrepParts';
import { Block, Fig, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
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
import { face, Fonts, themed, Type, useTheme } from '@/constants/Theme';


/** One official session at a glance, as a ruled column of the programme: where our car finished (overall, big, and
 * in class), the gaps, our best lap against the fastest, the class and our make, the weather, what our logged best lap
 * would have been worth, and our logged sessions in it. The makes table opens on a tap. `current` hides the link to the
 * session already open. */
export function OfficialSessionCard({ s, current, bare }: { s: OfficialSession; current?: number;
  bare?: boolean; // under a heading of its own that names it: no thick rule on top, no title
}) {
  const styles = useStyles();
  const type = usePrepType();
  const [makes, setMakes] = useState(false);
  const race = s.kind === 'race';
  const head = [startLabel(s.starts_at), `${s.cars} cars`].filter(Boolean).join(' · ');
  const weather = weatherLabel(s.weather);
  const ours = s.our_sessions.filter((o) => o.id !== current);
  const fastest = s.fastest_s != null
    ? `${race ? 'Fastest lap' : 'Pole'} ${formatLap(s.fastest_s)}${s.fastest_car ? ` ${s.fastest_car}` : ''}`
    : s.fastest || null;

  return (
    <View style={StyleSheet.flatten([styles.card, bare && styles.cardBare])}>
      {!bare && <Text style={styles.title}>{s.title}</Text>}
      {head ? <Text style={styles.head}>{head}</Text> : null}
      {s.us ? <Ours us={s.us} race={race} s={s} /> : fastest && <Text style={styles.line}>{fastest}</Text>}
      {s.logged_best_s != null && (
        <Text style={styles.line}>
          Your logged best {formatLap(s.logged_best_s)}
          {s.logged_rank != null ? ` would be P${s.logged_rank}` : ''}
        </Text>
      )}
      {weather && <Text style={type.small}>{weather}</Text>}
      {ours.length > 0 && (
        <View style={styles.links}>
          <Text style={type.small}>Our {ours.length === 1 ? 'session' : 'sessions'}:</Text>
          {ours.map((o) => (
            <TextLink key={o.id} label={o.name} small href={{ pathname: '/session/[id]', params: { id: o.id } }} />
          ))}
        </View>
      )}
      <View style={styles.links}>
        {s.brands.length > 0 && (
          <TextLink label={makes ? 'Hide the makes' : 'Makes'} small onPress={() => setMakes(!makes)} />
        )}
        {!!s.source_url && (
          <TextLink label="Official sheet (PDF)" small arrow onPress={() => Linking.openURL(s.source_url)} />
        )}
      </View>
      {makes && <Makes s={s} ourBrand={s.us?.brand} />}
    </View>
  );
}

function Ours({ us, race, s }: { us: OurResult; race: boolean; s: OfficialSession }) {
  const theme = useTheme();
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  const out = us.status !== 'classified';
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
      {out && (
        <View style={styles.statusRow}>
          <Block label={us.status} color={theme.status.critical} ink={onFill(theme.status.critical)} />
          <Text style={styles.statusText}>{STATUS_NAMES[us.status]}</Text>
        </View>
      )}
      {us.position != null ? (
        <Fig label="Overall" value={`P${us.position}`} size={wide ? 56 : 48} note={inClass ?? undefined} />
      ) : (
        <Text style={styles.place}>{inClass ?? STATUS_NAMES[us.status]}</Text>
      )}
      {!!gaps && <Text style={styles.line}>{gaps}</Text>}
      {best && <Text style={styles.line}>{best}</Text>}
      {(classBest || brandBest) && (
        <Text style={type.small}>{[classBest, brandBest].filter(Boolean).join(' · ')}</Text>
      )}
    </View>
  );
}

function Makes({ s, ourBrand }: { s: OfficialSession; ourBrand?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.table}>
      <View style={styles.thRow}>
        <Text style={StyleSheet.flatten([styles.th, styles.cBrand])}>Make</Text>
        <Text style={StyleSheet.flatten([styles.th, styles.cNum])}>Best lap</Text>
        <Text style={StyleSheet.flatten([styles.th, styles.cNum])}>To fastest</Text>
        <Text style={StyleSheet.flatten([styles.th, styles.cNum])}>Best place</Text>
      </View>
      {s.brands.map((b) => {
        const ours = b.brand === ourBrand;
        return (
          // our make: a band of the darker paper across the row, in bold
          <View key={b.brand} style={StyleSheet.flatten([styles.tr, ours && styles.trOurs])}>
            <Text style={StyleSheet.flatten([styles.td, styles.cBrand, ours && styles.bold])} numberOfLines={1}>
              {b.brand} <Text style={styles.count}>×{b.cars}</Text>
            </Text>
            <Text style={StyleSheet.flatten([styles.td, styles.cNum, ours && styles.bold])}>{formatLap(b.best_s)}</Text>
            <Text style={StyleSheet.flatten([styles.td, styles.cNum, ours && styles.bold])}>
              {b.to_fastest_pct ? percent(b.to_fastest_pct) : '–'}</Text>
            <Text style={StyleSheet.flatten([styles.td, styles.cNum, ours && styles.bold])}>
              {b.best_position != null ? `P${b.best_position}` : '–'}</Text>
          </View>
        );
      })}
    </View>
  );
}

const ordinal = (n: number) => {
  const t = n % 100;
  const suffix = t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
};

const useStyles = themed((c) => ({
  // no card: a column under a thick ink rule
  card: { borderTopWidth: 3, borderColor: c.rule, paddingTop: 8, paddingBottom: 6, gap: 6 },
  cardBare: { borderTopWidth: 0, paddingTop: 0 },
  title: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 29, textTransform: 'uppercase', color: c.text },
  head: { ...Type.label, fontFamily: face('label', 600), fontSize: 12, letterSpacing: 1, color: c.textSecondary },
  us: { gap: 6, marginTop: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  statusText: { fontFamily: face('label', 600), fontSize: 14, color: c.error },
  place: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 33, color: c.text },
  line: { fontFamily: face('label', 500), fontSize: 15, lineHeight: 20, fontVariant: ['tabular-nums'], color: c.text },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 8, alignItems: 'center', marginTop: 4 },
  table: { marginTop: 8 },
  thRow: { flexDirection: 'row', gap: 6, borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 4 },
  th: { ...Type.label, fontFamily: face('label', 700), fontSize: 11, letterSpacing: 1, color: c.text },
  tr: { flexDirection: 'row', gap: 6, paddingVertical: 5, paddingHorizontal: 3, borderBottomWidth: 1, borderColor: c.separator },
  trOurs: { backgroundColor: c.band },
  td: { fontFamily: face('label', 500), fontSize: 14, fontVariant: ['tabular-nums'], color: c.text },
  count: { fontFamily: face('label', 500), fontSize: 12, color: c.textSecondary },
  cBrand: { flex: 1.4, minWidth: 0 },
  cNum: { flex: 1, textAlign: 'right' },
  bold: { fontFamily: face('label', 700) },
  session: { marginTop: 8 },
}));

/** On a session's page: the official session this run was part of, or nothing (the server's note, small, when
 * it has one). Its own heading, a sub-head under a thick rule, unless `heading` is false (inside a section of its
 * own). */
export function SessionResults({ sessionId, heading = true }: { sessionId: number; heading?: boolean }) {
  const styles = useStyles();
  const type = usePrepType();
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
  if (!run.official) return run.note ? <Text style={type.small}>{run.note}</Text> : null;
  return (
    <View style={styles.session}>
      {heading && <SubHead kicker="Official result" title={run.official.title} />}
      <OfficialSessionCard s={run.official} current={sessionId} bare={heading} />
    </View>
  );
}
