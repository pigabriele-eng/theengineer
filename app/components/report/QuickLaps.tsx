// The report's grip, balance and tyre figures, from the quick laps of the stint analysis (GET /stint): the g the car
// pulls in each driving phase, how it is balanced in each, and each tyre's hot TPMS temperature and hot pressure.
// Quick laps are the flying laps within 1 % of the quickest. The tyres are coloured against the car's own middle (the
// median of its four corners), not against a window: Pirelli publishes no GT4 temperature window, and the hot
// pressure window is in the team's P_Book.
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { Fig, Label, Swatch } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { useWide } from '@/components/Programme';
import { BalancePhase, fetchStintLogs, fetchStintView, GRIP_PHASES, GripPhase, signed, StintLap } from '@/lib/stint';
import { Fonts, phaseColor, themed, Type, useTheme } from '@/constants/Theme';
import { Palette } from '@/constants/Colors';

// an event, one run, or some runs (an official session's: FP1 stint 1 and 2)
export type LapsScope = { event: number } | { session: number } | { sessions: number[] };

const QUICK = 1.01; // within 1 % of the quickest flying lap

/** The quick laps of an event, a session or some sessions, from the stint analysis of their main logs. */
export function useQuickLaps(scope: LapsScope | null) {
  const key = !scope ? '' : 'event' in scope ? `e${scope.event}` : 'session' in scope ? `s${scope.session}`
    : `r${scope.sessions.join(',')}`;
  const [state, setState] = useState<{ laps: StintLap[] | null; error: string | null }>({ laps: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ laps: null, error: null });
    if (!scope) return;
    (async () => {
      const events = await fetchStintLogs();
      const sessions = events.flatMap((e) => ('event' in scope ? (e.id === scope.event ? e.sessions : [])
        : 'session' in scope ? e.sessions.filter((s) => s.id === scope.session)
          : e.sessions.filter((s) => scope.sessions.includes(s.id))));
      const files = sessions.flatMap((s) => s.files.filter((f) => f.main && f.laps > 0).map((f) => f.id));
      if (files.length === 0) return [];
      const view = await fetchStintView(files);
      const flying = view.stints.flatMap((s) => s.laps).filter((l) => l.kind === 'flying' && l.tag == null);
      const best = Math.min(...flying.map((l) => l.time));
      return flying.filter((l) => l.time <= best * QUICK);
    })().then(
      (laps) => live && setState({ laps, error: null }),
      (e) => live && setState({ laps: null, error: (e as Error).message }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

export const median = (vs: (number | null | undefined)[]) => {
  const v = vs.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

// ---------- grip and balance ----------

const GRIP_TONE: Record<GripPhase, string> = {
  braking: 'braking', trail: 'entry', mid: 'mid-corner', exit: 'exit', power: 'full throttle',
};
const BALANCE: { key: BalancePhase; label: string }[] = [
  { key: 'entry', label: 'Trail braking' },
  { key: 'mid', label: 'Mid-corner' },
  { key: 'exit', label: 'Exit' },
];
const NEUTRAL_DEG = 0.15; // closer to the car's normal than this: neutral

/** The g the car pulls in each phase on the quick laps (median), and its balance in the three phases that turn. */
export function GripBalance({ laps }: { laps: StintLap[] }) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const grip = GRIP_PHASES.map((p) => ({ ...p, g: median(laps.map((l) => l.grip?.[p.key])) }));
  const bal = BALANCE.map((b) => ({ ...b, deg: median(laps.map((l) => l.balance?.[b.key])) }));
  const span = Math.max(1, ...bal.map((b) => Math.abs(b.deg ?? 0)));
  const words = balanceWords(bal);
  return (
    <View style={wide ? styles.gb : undefined}>
      <View style={wide ? styles.gripSide : undefined}>
        <Text style={styles.headLabel}>Grip by phase</Text>
        <View style={styles.gripFigs}>
          {grip.map((p, i) => (
            <View key={p.key} style={StyleSheet.flatten([wide ? styles.gripFig : styles.gripFigPhone,
              wide && i === 0 && styles.gripFirst])}>
              <Label small>{p.label}</Label>
              <Fig value={p.g != null ? p.g.toFixed(2) : '–'} unit="g" size={40}
                bar={phaseColor(c, GRIP_TONE[p.key])} />
            </View>
          ))}
        </View>
      </View>
      <View style={wide ? styles.balSide : styles.balPhone}>
        <Text style={styles.headLabel}>Balance, ° against the car&apos;s normal</Text>
        <View style={wide ? styles.balEnds : styles.balEndsPhone}>
          <Swatch color={c.balance.over} label="Oversteer" />
          <Swatch color={c.balance.under} label="Understeer" />
        </View>
        {bal.map((b) => (
          <View key={b.key} style={styles.balRow}>
            <Text style={styles.balName}>{b.label}</Text>
            <View style={styles.axis}>
              <View style={styles.zero} />
              {b.deg != null && Math.abs(b.deg) > 0.005 && (
                <View style={StyleSheet.flatten([styles.balBar, {
                  backgroundColor: b.deg > 0 ? c.balance.under : c.balance.over,
                  width: `${(Math.abs(b.deg) / span) * 50}%`,
                }, b.deg > 0 ? { left: '50%' } : { right: '50%' }])} />
              )}
            </View>
            <Text style={styles.balValue}>{b.deg != null ? `${signed(b.deg)}°` : '–'}</Text>
          </View>
        ))}
        {words ? <Text style={styles.note}>{words}</Text> : null}
      </View>
    </View>
  );
}

/** "Mid-corner it pushes; trail braking and exit it turns a little loose." */
function balanceWords(bal: { label: string; deg: number | null }[]) {
  const under = bal.filter((b) => b.deg != null && b.deg >= NEUTRAL_DEG).map((b) => b.label.toLowerCase());
  const over = bal.filter((b) => b.deg != null && b.deg <= -NEUTRAL_DEG).map((b) => b.label.toLowerCase());
  const even = bal.filter((b) => b.deg != null && Math.abs(b.deg) < NEUTRAL_DEG).map((b) => b.label.toLowerCase());
  const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  const parts = [
    under.length ? `${cap(and(under))} it pushes (understeer)` : null,
    over.length ? `${under.length ? 'in ' : ''}${under.length ? and(over) : cap(and(over))} it turns loose (oversteer)` : null,
    even.length ? `${and(even)} it is neutral` : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join('; ')}. Median of the quick laps; + is understeer.` : null;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- tyres ----------

const CORNERS = ['fl', 'fr', 'rl', 'rr'] as const;
export type CornerKey = (typeof CORNERS)[number];
// steps of the tyre scale against the middle: colder, cooler, even, warmer, hotter
const STEP = { temperature_c: [10, 4], pressure_bar: [0.06, 0.03] } as const;
export type TyreMeasure = keyof typeof STEP;

/** The step (0 to 4, cold to hot) of a tyre reading against a middle value. */
export function tyreStep(value: number, middle: number, measure: TyreMeasure) {
  const [far, near] = STEP[measure];
  const d = value - middle;
  if (d <= -far) return 0;
  if (d <= -near) return 1;
  if (d < near) return 2;
  if (d < far) return 3;
  return 4;
}

/** The legend of the tyre scale against the middle. */
export function TyreScale({ measure }: { measure: TyreMeasure }) {
  const styles = useStyles();
  const c = useTheme();
  const [far, near] = STEP[measure];
  const u = measure === 'temperature_c' ? ' °C' : ' bar';
  const n = (v: number) => (measure === 'temperature_c' ? String(v) : v.toFixed(2));
  const names = [`Colder\n${n(far)}${u} or more under`, `Cooler\n${n(near)}–${n(far)} under`, `Even\nwithin ${n(near)}`,
    `Warmer\n${n(near)}–${n(far)} over`, `Hotter\n${n(far)}${u} or more over`];
  if (measure === 'pressure_bar') names.splice(0, 5, `Lower\n${n(far)}${u} or more under`, `Low\n${n(near)}–${n(far)} under`,
    `Even\nwithin ${n(near)}`, `High\n${n(near)}–${n(far)} over`, `Higher\n${n(far)}${u} or more over`);
  return (
    <View style={styles.scale}>
      {names.map((t, i) => (
        <View key={t} style={styles.scaleStep}>
          <View style={{ height: 14, backgroundColor: c.tyre.scale[i] }} />
          <Text style={styles.scaleText}>{t}</Text>
        </View>
      ))}
    </View>
  );
}

/** Each tyre's hot TPMS temperature and hot pressure on the quick laps (median), on a plan of the car, coloured
 * against the middle of the four. */
export function TyreCorners({ laps }: { laps: StintLap[] }) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const at = (m: TyreMeasure) => Object.fromEntries(CORNERS.map((k) => [k, median(laps.map((l) => l.tyres?.[m]?.[k]))])) as
    Record<CornerKey, number | null>;
  const temp = at('temperature_c');
  const bar = at('pressure_bar');
  const mid = (v: Record<CornerKey, number | null>) => median(CORNERS.map((k) => v[k]));
  const tMid = mid(temp);
  const pMid = mid(bar);
  if (tMid == null && pMid == null) {
    return <Text style={styles.note}>No TPMS readings in these logs.</Text>;
  }
  const front = median([temp.fl, temp.fr]);
  const rear = median([temp.rl, temp.rr]);
  const corner = (k: CornerKey) => {
    const ts = temp[k] != null && tMid != null ? tyreStep(temp[k]!, tMid, 'temperature_c') : 2;
    const ps = bar[k] != null && pMid != null ? tyreStep(bar[k]!, pMid, 'pressure_bar') : 2;
    return (
      <View key={k} style={StyleSheet.flatten([styles.corner, { backgroundColor: c.tyre.scale[ts] }])}>
        <Text style={StyleSheet.flatten([styles.pos, { color: c.tyre.onScale[ts] }])}>{k.toUpperCase()}</Text>
        <Text style={StyleSheet.flatten([styles.cornerFig, { color: c.tyre.onScale[ts] }])}>
          {temp[k] != null ? Math.round(temp[k]!) : '–'}
          <Text style={StyleSheet.flatten([styles.cornerUnit, { color: c.tyre.onScale[ts] }])}> °C</Text>
        </Text>
        <View style={StyleSheet.flatten([styles.pr, { backgroundColor: c.tyre.scale[ps] }])}>
          <Text style={StyleSheet.flatten([styles.prText, { color: c.tyre.onScale[ps] }])}>
            {bar[k] != null ? `${bar[k]!.toFixed(2)} bar` : '–'}
          </Text>
        </View>
      </View>
    );
  };
  return (
    <View style={wide ? styles.tyres : styles.tyresPhone}>
      <View style={wide ? styles.car : undefined}>
        <Text style={styles.carLabel}>Front</Text>
        <View style={styles.axle}>{corner('fl')}{corner('fr')}</View>
        <View style={StyleSheet.flatten([styles.axle, styles.axleGap])}>{corner('rl')}{corner('rr')}</View>
        <Text style={styles.carLabel}>Rear</Text>
      </View>
      <View style={styles.notes}>
        <Text style={StyleSheet.flatten([styles.notesHead, styles.notesFirst])}>Temperature, against the car&apos;s middle ({tMid != null ? `${Math.round(tMid)} °C` : '–'})</Text>
        <TyreScale measure="temperature_c" />
        <Text style={styles.notesHead}>Hot pressure, against the car&apos;s middle ({pMid != null ? `${pMid.toFixed(2)} bar` : '–'})</Text>
        <TyreScale measure="pressure_bar" />
        <Text style={styles.notesHead}>What the data say</Text>
        {front != null && rear != null && Math.abs(front - rear) >= 4 && (
          <Text style={styles.para}>
            The {front > rear ? 'rears' : 'fronts'} run {Math.round(Math.abs(front - rear))} °C cooler than the{' '}
            {front > rear ? 'fronts' : 'rears'}: {Math.round(Math.min(front, rear))} against {Math.round(Math.max(front, rear))} °C.
          </Text>
        )}
        <Text style={styles.para}>
          Median of {laps.length} quick {laps.length === 1 ? 'lap' : 'laps'}. Coloured against the car&apos;s own middle:
          Pirelli publishes no GT4 temperature window, and the hot pressure window is in your P_Book (Tools › Tyre
          pressures).
        </Text>
      </View>
    </View>
  );
}

/** Loads the quick laps and draws `children` with them; a line while they load or when there are none. */
export function WithQuickLaps({ scope, children }: { scope: LapsScope; children: (laps: StintLap[]) => React.ReactNode }) {
  const styles = useStyles();
  const { laps, error } = useQuickLaps(scope);
  if (error) return <Text style={styles.note}>These figures didn&apos;t load: {error}</Text>;
  if (!laps) return <ActivityIndicator style={styles.loading} />;
  if (!laps.length) return <Text style={styles.note}>No flying laps to measure yet.</Text>;
  return <>{children(laps)}</>;
}

const useStyles = themed((c: Palette) => ({
  loading: { alignSelf: 'flex-start', marginVertical: 12 },
  note: { ...Type.dek, fontSize: 15, lineHeight: 21, color: c.textSecondary, marginTop: 10 },
  para: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text, marginTop: 6 },
  headLabel: { ...Type.label, color: c.text, borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 6, marginBottom: 12 },
  gb: { flexDirection: 'row' },
  gripSide: { flex: 1.45, paddingRight: 30, borderRightWidth: 1, borderColor: c.rule },
  balSide: { flex: 1, paddingLeft: 30 },
  balPhone: { borderTopWidth: 3, borderColor: c.rule, paddingTop: 12, marginTop: 10 },
  gripFigs: { flexDirection: 'row', flexWrap: 'wrap' },
  gripFig: { flex: 1, minWidth: 0, paddingHorizontal: 12, paddingBottom: 14, borderLeftWidth: 1, borderColor: c.rule },
  gripFirst: { paddingLeft: 0, borderLeftWidth: 0 },
  gripFigPhone: { width: '33.33%', paddingRight: 10, paddingBottom: 14 },
  balEnds: { flexDirection: 'row', justifyContent: 'space-between', marginLeft: 106, marginRight: 66, marginBottom: 6 },
  balEndsPhone: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  balRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 9, paddingBottom: 8, borderBottomWidth: 1,
    borderColor: c.separator },
  balName: { ...Type.label, width: 96, color: c.text },
  axis: { flex: 1, height: 22, position: 'relative' },
  zero: { position: 'absolute', left: '50%', top: -9, bottom: -8, width: 2, backgroundColor: c.rule },
  balBar: { position: 'absolute', top: 0, bottom: 0 },
  balValue: { ...Type.number, fontFamily: Type.label.fontFamily, fontSize: 16, width: 56, textAlign: 'right', color: c.text },

  tyres: { flexDirection: 'row', gap: 32 },
  tyresPhone: { flexDirection: 'column', gap: 20 },
  car: { width: 330 },
  carLabel: { ...Type.label, textAlign: 'center', marginVertical: 6, color: c.text },
  axle: { flexDirection: 'row', gap: 10 },
  axleGap: { marginTop: 10 },
  corner: { flex: 1, borderWidth: 2, borderColor: c.rule, paddingTop: 10, paddingHorizontal: 12, height: 140 },
  pos: { ...Type.label, letterSpacing: 1.4 },
  cornerFig: { fontFamily: Fonts.display, fontSize: 60, lineHeight: 64, marginTop: 4 },
  cornerUnit: { fontFamily: Fonts.display, fontSize: 25 },
  pr: { marginTop: 'auto', marginHorizontal: -12, paddingHorizontal: 12, paddingTop: 5, paddingBottom: 4, borderTopWidth: 2,
    borderColor: c.rule },
  prText: { ...Type.number, fontFamily: Type.label.fontFamily, fontSize: 15 },
  notes: { flex: 1, minWidth: 0 },
  notesHead: { ...Type.label, fontSize: 13, color: c.text, borderTopWidth: 3, borderColor: c.rule, paddingTop: 6, marginTop: 16 },
  notesFirst: { marginTop: 0 },
  scale: { flexDirection: 'row', marginTop: 8 },
  scaleStep: { flex: 1 },
  scaleText: { fontFamily: Fonts.label, fontSize: 11, lineHeight: 14, marginTop: 3, color: c.text },
}));
