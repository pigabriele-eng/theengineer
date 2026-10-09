// Grip use and traction control, for one session or a whole event: the headline numbers with what to do about
// them first, then the charts behind them. Renders no scroll view of its own, so it sits inside the report screen.
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

import { Text, View } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import {
  fetchGrip,
  GripResult,
  GripSection,
  Headline,
  PHASES,
  quickestLapsLine,
  signedR,
  TcZone,
  Verdict,
} from '@/lib/grip';
import { noPrint } from '@/lib/print';
import { a11yState } from '@/lib/a11yState';

import { ChartColors, Dumbbell, GgDiagram, GripMap, inkOn, LegendItem, ramp, Scatter, useChartColors } from './GripCharts';
import { Fonts, legibleFill, TAP, tapRoom, themed, Type } from '@/constants/Theme';

const UPDATE_EVERY_MS = 20000;
const UPDATE_TRIES = 30;

// bare: inside a report section that already names it, so without its own heading
type Props = { session?: number; event?: number; bare?: boolean };

export function GripReport({ session, event, bare }: Props) {
  const styles = useStyles();
  const [data, setData] = useState<GripResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session == null && event == null) return;
    let live = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    setError(null);
    // a report worked out by the earlier version of the page comes marked updating while the server works out the
    // new one: shown meanwhile, and asked for again until the new one is there
    const load = () =>
      fetchGrip({ session, event })
        .then((r) => {
          if (!live) return;
          setData(r);
          if (r.updating && ++tries < UPDATE_TRIES) timer = setTimeout(load, UPDATE_EVERY_MS);
        })
        .catch((e) => live && tries === 0 && setError((e as Error).message));
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [session, event]);

  if (session == null && event == null) return <Text style={styles.dim}>Pick a session or an event.</Text>;
  if (error) return <Text style={styles.error}>{error}</Text>;
  if (!data) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
        <Text style={styles.dim}>
          Reading the logs one at a time. A whole event can take a minute the first time; after that it opens at once.
        </Text>
      </View>
    );
  }
  if (!data.available) {
    return (
      <View style={styles.wrap}>
        {!bare && <Text style={styles.h2}>Grip use and traction control</Text>}
        {data.notes.map((n) => (
          <Text key={n} style={styles.dim}>
            {n}
          </Text>
        ))}
      </View>
    );
  }
  return <Report data={data} bare={bare} />;
}

export default GripReport;

function Report({ data, bare }: { data: GripResult; bare?: boolean }) {
  const styles = useStyles();
  const c = useChartColors();
  const sections = data.sections ?? [];
  const sectionAt = (m: number) => sections.find((s) => m >= s.start_m && m < s.end_m)?.code ?? '';
  const runs = data.runs.filter((r) => r.clean_laps > 0).length;
  const fastest = data.fastest!;
  return (
    <View style={styles.wrap}>
      <View style={styles.block}>
        {!bare && <Text style={styles.h2}>Grip use and traction control</Text>}
        <Text style={styles.dim}>
          {data.clean_laps} clean laps from {runs} {runs === 1 ? 'run' : 'runs'}. The quick laps are the{' '}
          {data.quick_laps} within 1 % of the best ({formatLap(fastest.time)}, {fastest.run} lap {fastest.lap}). Grip use
          is the share of the car's grip limit in use while braking and cornering.
        </Text>
        {data.quickest_laps && <Text style={styles.dim}>{quickestLapsLine(data.quickest_laps)}</Text>}
        {data.updating && (
          <Text style={styles.dim}>
            This report is being brought up to date with the newest version of the analysis. It refreshes by itself.
          </Text>
        )}
      </View>

      <View style={styles.tiles}>
        {(data.headlines ?? []).map((h) => (
          <HeadlineTile key={h.key} h={h} />
        ))}
      </View>

      <LapsVsGrip data={data} c={c} />
      <PhaseGap data={data} c={c} />
      <SectionTable sections={sections} c={c} />
      <GgBlock data={data} c={c} sectionAt={sectionAt} />
      {data.map && (
        <View style={styles.block}>
          <Text style={styles.h3}>On the track</Text>
          <GripMap
            x={data.map.x}
            y={data.map.y}
            step={data.map.step_m}
            modes={[
              { key: 'grip', label: 'Grip use', values: data.map.grip_use, ramp: c.seq, lo: 50, hi: 100, unit: '%' },
              ...(data.map.tc
                ? [{ key: 'tc', label: 'Traction control', values: data.map.tc, ramp: c.tc, lo: 0, hi: 100,
                    unit: '% of quick laps', skipBelow: 5 }]
                : []),
            ]}
            labels={sections.map((s) => ({ code: s.code, at: s.apex_m ?? (s.start_m + s.end_m) / 2 }))}
            describe={(m) => `${sectionAt(m)} · ${Math.round(m)} m`}
          />
          <Text style={styles.caption}>
            Grip use on a typical quick lap (the median of the quick laps at each point); grey where the quick laps are
            mostly at full throttle and the engine, not the tyres, is the limit.
          </Text>
        </View>
      )}
      <TractionControl data={data} c={c} />
      <View style={styles.block}>
        <Text style={styles.h3}>How it is measured</Text>
        <Text style={styles.caption}>
          The grip limit is the 98th percentile of combined g (lateral and longitudinal together) in each 10° direction
          and speed band, from the laps within 2 % of the quickest: what this car showed it can do, often. Grip use is
          combined g over that limit, averaged over the time spent braking, turning in, mid-corner and on the exit.
          The quicker and the slower of the quick laps are compared lap to lap, so a link is a strong hint, not a guarantee that more grip use
          alone finds the time.
        </Text>
        {data.notes.map((n) => (
          <Text key={n} style={styles.caption}>
            {n}
          </Text>
        ))}
      </View>
    </View>
  );
}

function HeadlineTile({ h }: { h: Headline }) {
  const styles = useStyles();
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{h.label}</Text>
      <Text style={styles.tileValue}>{h.value}</Text>
      <Text style={styles.tileDetail}>{h.detail}</Text>
      <Text style={styles.tileAction}>
        <Text style={styles.bold}>What to do: </Text>
        {h.action}
      </Text>
    </View>
  );
}

function LapsVsGrip({ data, c }: { data: GripResult; c: ChartColors }) {
  const styles = useStyles();
  const g = data.grip!;
  const laps = (data.laps ?? []).filter((l) => l.grip_use != null);
  const vt = g.vs_time;
  return (
    <View style={styles.block}>
      <Text style={styles.h3}>Lap time against grip use</Text>
      <Scatter
        points={laps.map((l) => ({
          x: l.grip_use as number,
          y: l.time,
          color: l.quick ? c.s1 : c.other,
          front: l.quick,
          label: `${l.run} lap ${l.lap} · ${formatLap(l.time)} · grip use ${(l.grip_use as number).toFixed(1)} %`,
        }))}
        fit={vt && vt.intercept != null ? { slope: vt.slope, intercept: vt.intercept } : null}
        xLabel="Grip use, %"
        yLabel="Lap time"
        yFmt={(v) => `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')}`}
        hint="Point at a lap to read it."
      />
      <View style={styles.legendRow}>
        <LegendItem color={c.s1} label="Quick laps" />
        <LegendItem color={c.other} label="Other clean laps" />
        <LegendItem color={c.ink2} label="Trend" kind="dash" />
      </View>
      <Text style={styles.caption}>
        {vt ? `r ${signedR(vt.r)} over ${vt.n} clean laps` : 'Too few laps for a trend (it takes 8)'}
        {g.vs_time_within ? `; on the quick laps, lap to lap within a run, r ${signedR(g.vs_time_within.r)}` : ''}.
        {g.typical != null ? ` A typical quick lap uses ${g.typical.toFixed(1)} % of the grip, the fastest ${g.best_lap?.toFixed(1)} %.` : ''}
      </Text>
    </View>
  );
}

function PhaseGap({ data, c }: { data: GripResult; c: ChartColors }) {
  const styles = useStyles();
  const ph = data.grip!.phases;
  return (
    <View style={styles.block}>
      <Text style={styles.h3}>Grip use by phase: quickest against slowest laps</Text>
      <Dumbbell
        rows={PHASES.map((p) => ({
          label: p.label,
          sub: `${ph.fast[p.key].time_s?.toFixed(1) ?? '–'} s · ${ph.slow[p.key].time_s?.toFixed(1) ?? '–'} s a lap`,
          fast: ph.fast[p.key].grip_use,
          slow: ph.slow[p.key].grip_use,
        }))}
        hint="Point at a phase to read it."
      />
      <View style={styles.legendRow}>
        <LegendItem color={c.s1} label="The quicker of the quick laps" />
        <LegendItem color={c.other} label="The slower of the quick laps" />
      </View>
      <Text style={styles.caption}>
        Under each phase: seconds a lap spent in it, the quicker of the quick laps, then the slower. Turn-in is braking while already
        cornering; mid-corner is off both pedals.
      </Text>
    </View>
  );
}

const MIN_PHASE_S = 0.3; // a phase shorter than this in a corner is left blank

function SectionTable({ sections, c }: { sections: GripSection[]; c: ChartColors }) {
  const styles = useStyles();
  const fill = (u: number) => ramp(c.seq, (u - 60) / 40);
  return (
    <View style={styles.block}>
      <Text style={styles.h3}>Where grip is left unused</Text>
      <View>
        <View style={styles.trow}>
          <Text style={[styles.th, styles.tcode]}>Corner</Text>
          {PHASES.map((p) => (
            <Text key={p.key} style={[styles.th, styles.tcell, styles.center]}>
              {p.label}
            </Text>
          ))}
          <Text style={[styles.th, styles.tworth]}>Worth</Text>
        </View>
        {sections.map((s) => (
          <View key={s.code} style={styles.trow}>
            <Text style={[styles.td, styles.tcode, styles.bold]}>{s.code}</Text>
            {PHASES.map((p) => {
              const ph = s.phases[p.key];
              if (ph.grip_use == null || (ph.time_s ?? 0) < MIN_PHASE_S) {
                return (
                  <View key={p.key} style={[styles.tcell, styles.cell]}>
                    <Text style={styles.dim}>–</Text>
                  </View>
                );
              }
              // the number on it reads at 4.5:1: the middle of the ramp is nudged to where one ink does
              const bg = legibleFill(fill(ph.grip_use));
              const gap = ph.fast != null && ph.slow != null ? ph.fast - ph.slow : null;
              return (
                <View key={p.key} style={[styles.tcell, styles.cell, { backgroundColor: bg }]}>
                  <Text style={[styles.cellValue, { color: inkOn(bg) }]}>{Math.round(ph.grip_use)} %</Text>
                  {gap != null && gap >= 1 && <Text style={[styles.cellGap, { color: inkOn(bg) }]}>+{Math.round(gap)}</Text>}
                </View>
              );
            })}
            <Text style={[styles.td, styles.tworth]}>{(s.worth_s ?? 0) >= 0.005 ? `${s.worth_s!.toFixed(2)} s` : '–'}</Text>
          </View>
        ))}
      </View>
      <View style={styles.legendRow}>
        <Text style={styles.legendText}>60 %</Text>
        <Svg width={90} height={8}>
          {Array.from({ length: 8 }, (_, k) => (
            <Rect key={k} x={k * 11.25} y={0} width={11.25} height={8} fill={ramp(c.seq, (k + 0.5) / 8)} />
          ))}
        </Svg>
        <Text style={styles.legendText}>100 % grip use, typical quick lap</Text>
      </View>
      <Text style={styles.caption}>
        +n: points more grip the quicker of the quick laps use than the slower. Worth: the time a typical quick lap
        would find in that corner using the grip like the quicker of the quick laps.
      </Text>
      <Text style={styles.h3}>What the quick laps do differently</Text>
      {sections.map((s) => (
        <View key={s.code} style={styles.noteRow}>
          <Text style={styles.noteHead}>
            <Text style={styles.bold}>{s.code}</Text>
            <Text style={styles.dim}>
              {s.grip_use_fast != null && s.grip_use_slow != null
                ? `  grip use ${s.grip_use_fast.toFixed(0)} % quick, ${s.grip_use_slow.toFixed(0)} % slow`
                : ''}
              {(s.worth_s ?? 0) >= 0.005 ? ` · worth ≈ ${s.worth_s!.toFixed(2)} s` : ''}
            </Text>
          </Text>
          <Text style={styles.note}>{s.note}</Text>
        </View>
      ))}
    </View>
  );
}

function GgBlock({ data, c, sectionAt }: { data: GripResult; c: ChartColors; sectionAt: (m: number) => string }) {
  const styles = useStyles();
  const lim = data.limits!;
  const gg = data.gg!;
  // start on the speed band that holds the most of the fastest lap's corners
  const busiest = useMemo(() => {
    const counts = lim.bands_kmh.map(([lo, hi]) => gg.fastest.speed.filter((v) => v >= lo && (hi == null || v < hi)).length);
    return counts.indexOf(Math.max(...counts));
  }, [lim, gg]);
  const [band, setBand] = useState(busiest);
  const describe = (name: string, lap: typeof gg.fastest) => (i: number) => {
    const ax = lap.ax[i];
    const load = lap.load?.[i] ?? 1;
    const per = load !== 1 ? ` per unit of the road's ${load.toFixed(2)} g load` : '';
    return `${name} · ${sectionAt(lap.m[i])} · ${lap.m[i]} m · ${lap.speed[i]} km/h · ${Math.abs(lap.ay[i]).toFixed(2)} g lateral, ${Math.abs(ax).toFixed(2)} g ${ax < 0 ? 'braking' : 'accelerating'}${per} · grip use ${lap.use[i]} %`;
  };
  // the road's shape: g is per unit of its load, as the limit is, and the banked corners', crests' and
  // compressions' dots are rings
  const laps = [gg.fastest, gg.typical];
  const shaped = laps.some((l) => l.shaped?.some(Boolean));
  const loaded = laps.some((l) => l.load?.some((v) => v !== 1));
  const label = ([lo, hi]: [number, number | null]) => (hi == null ? `${lo}+ km/h` : `${lo}–${hi} km/h`);
  return (
    <View style={styles.block}>
      <Text style={styles.h3}>The g-g diagram and the grip limit</Text>
      <View style={styles.tabs} accessibilityRole="tablist">
        {lim.bands_kmh.map((b, i) => (
          <Pressable key={i} onPress={() => setBand(i)} {...(i === band ? null : noPrint)} accessibilityRole="tab"
            {...a11yState({ selected: i === band })} style={styles.tabHit}>
            <View style={i === band ? [styles.tab, { borderColor: c.ink }] : styles.tab}>
              <Text style={i === band ? styles.tabOn : styles.tabText}>{label(b)}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      <GgDiagram
        limit={{ directions: lim.directions_deg, radius: lim.envelope_g[band] }}
        band={lim.bands_kmh[band]}
        series={[
          { name: 'Typical quick lap', color: c.s2, ...gg.typical, label: describe('Typical quick lap', gg.typical) },
          { name: 'Fastest lap', color: c.s1, ...gg.fastest, label: describe('Fastest lap', gg.fastest) },
        ]}
        hint="Point at a dot to read it."
      />
      <View style={styles.legendRow}>
        <LegendItem color={c.s1} label={`Fastest lap, ${formatLap(gg.fastest.time)}`} />
        <LegendItem color={c.s2} label={`Typical quick lap, ${formatLap(gg.typical.time)}`} />
        <LegendItem color={c.ink2} label="Grip limit at this speed" kind="dash" />
        {shaped && <LegendItem color={c.ink2} label="On a banked corner, a crest or a compression" kind="ring" />}
      </View>
      <Text style={styles.caption}>
        Each dot is the car's lateral and longitudinal g at one point of the lap, every 5 m, braking and cornering only.
        Dots on the outline use all the grip the car has shown at this speed; dots inside it leave some unused.
        {loaded
          ? ' Where the road presses the car down or lifts it, g is per unit of that load, as on a level road, so every dot reads against the same outline.'
          : ''}
      </Text>
    </View>
  );
}

const VERDICT: Record<Verdict, { label: string; color: keyof ChartColors | null }> = {
  cost: { label: 'Costs time', color: 'critical' },
  minor: { label: 'Small loss', color: 'warning' },
  pushing: { label: 'Sign of pushing', color: 'good' },
  none: { label: 'No effect', color: null },
  unknown: { label: 'Needs 4 laps', color: null }, // what TC costs compares 4 laps or more (grip.TC_FIT_LAPS)
};

function VerdictBadge({ v, c }: { v: Verdict; c: ChartColors }) {
  const styles = useStyles();
  const color = VERDICT[v].color;
  return (
    <View style={styles.badge}>
      <View style={[styles.legendDot, { backgroundColor: color ? (c[color] as string) : c.muted }]} />
      <Text style={styles.badgeText}>{VERDICT[v].label}</Text>
    </View>
  );
}

const ZONE_COLUMNS: { title: string; width: number; compact?: boolean; value: (z: TcZone) => string }[] = [
  { title: 'Metres', width: 92, value: (z) => `${z.start_m}–${z.end_m}` },
  { title: 'Quick laps', width: 70, compact: true, value: (z) => `${Math.round(100 * z.quick_share)} %` },
  { title: 'TC time', width: 60, compact: true, value: (z) => `${z.tc_s.toFixed(2)} s` },
  { title: 'Wheelspin', width: 72, value: (z) => (z.slip_pct != null ? `${z.slip_pct.toFixed(0)} %` : '–') },
  {
    title: 'Speed 150 m on',
    width: 104,
    value: (z) => (z.speed_loss_kmh != null ? `${z.speed_loss_kmh > 0 ? '+' : z.speed_loss_kmh < 0 ? '−' : ''}${Math.abs(z.speed_loss_kmh).toFixed(1)} km/h` : '–'),
  },
];

function TractionControl({ data, c }: { data: GripResult; c: ChartColors }) {
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const tc = data.tc!;
  if (!tc.available) {
    return (
      <View style={styles.block}>
        <Text style={styles.h3}>Traction control</Text>
        {tc.notes.map((n) => (
          <Text key={n} style={styles.dim}>
            {n}
          </Text>
        ))}
      </View>
    );
  }
  const costly = tc.zones.filter((z) => z.verdict === 'cost' || z.verdict === 'minor');
  // the zones of fewer than 4 laps say what TC does there from what laps there are
  const shown = tc.zones.filter((z) => z.verdict === 'cost' || z.verdict === 'minor' || z.verdict === 'unknown');
  const top = costly.find((z) => z.points.length > 0);
  const laps = (data.laps ?? []).filter((l) => l.tc_s != null && l.rear_tyre_c != null);
  const temp = tc.vs_rear_temp;
  const within = tc.vs_rear_temp_within;
  const vt = tc.vs_time_within ?? tc.vs_time;
  const sw = tc.switch;
  const narrow = width > 0 && width < 640;
  const columns = narrow ? ZONE_COLUMNS.filter((col) => col.compact) : ZONE_COLUMNS;
  return (
    <View style={styles.block} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Text style={styles.h2}>Traction control</Text>
      <View style={styles.facts}>
        <View style={styles.fact}>
          <Text style={styles.tileLabel}>Lost to TC</Text>
          <Text style={styles.factValue}>
            {tc.lost_per_lap_s != null ? `≈ ${tc.lost_per_lap_s.toFixed(2)} s a lap` : 'Needs 4 laps'}
          </Text>
        </View>
        <View style={styles.fact}>
          <Text style={styles.tileLabel}>TC working</Text>
          <Text style={styles.factValue}>{tc.per_lap_s?.toFixed(1) ?? '–'} s a lap</Text>
        </View>
      </View>
      <Text style={styles.caption}>
        Every stretch where TC cuts in with the throttle open on at least one quick lap in twelve. Passes with more TC
        are compared with passes with less at the same entry speed: the speed 150 m on and the time to the next braking
        point say whether TC costs time there or only trims wheelspin while you push.
      </Text>
      <View>
        <View style={styles.trow}>
          <Text style={[styles.th, { width: 108 }]}>Where</Text>
          {columns.map((col) => (
            <Text key={col.title} style={[styles.th, styles.num, { width: col.width }]}>
              {col.title}
            </Text>
          ))}
          <Text style={[styles.th, styles.verdictCol]}>Verdict</Text>
        </View>
        {tc.zones.map((z) => (
          <View key={`${z.start_m}`} style={styles.trow}>
            <View style={{ width: 108 }}>
              <Text style={[styles.td, styles.bold]}>{z.where}</Text>
              {narrow && <Text style={styles.subtle}>{`${z.start_m}–${z.end_m} m`}</Text>}
            </View>
            {columns.map((col) => (
              <Text key={col.title} style={[styles.td, styles.num, { width: col.width }]}>
                {col.value(z)}
              </Text>
            ))}
            <View style={styles.verdictCol}>
              <VerdictBadge v={z.verdict} c={c} />
            </View>
          </View>
        ))}
      </View>
      {shown.map((z) => (
        <View key={`n${z.start_m}`} style={styles.zoneCard}>
          <View style={styles.zoneHead}>
            <Text style={styles.bold}>
              {z.where} · {z.start_m}–{z.end_m} m
            </Text>
            <VerdictBadge v={z.verdict} c={c} />
          </View>
          <Text style={styles.note}>{z.note}</Text>
          {!!z.advice && (
            <Text style={styles.note}>
              <Text style={styles.bold}>What to do: </Text>
              {z.advice}
            </Text>
          )}
          {z.torque_cut_nm != null && z.verdict !== 'unknown' && (
            <Text style={styles.caption}>TC took about {z.torque_cut_nm.toFixed(0)} Nm of engine torque while it worked here.</Text>
          )}
        </View>
      ))}
      {top && (
        <>
          <Text style={styles.h3}>{top.where}: speed 150 m on against TC time</Text>
          <Scatter
            points={top.points.map(([x, y, quick]) => ({
              x,
              y,
              color: quick ? c.s1 : c.other,
              front: quick,
              label: `${x.toFixed(2)} s of TC · ${y >= 0 ? '+' : '−'}${Math.abs(y).toFixed(1)} km/h against a pass with the same entry speed`,
            }))}
            fit={
              top.speed_per_tc_s != null
                ? {
                    slope: top.speed_per_tc_s,
                    intercept:
                      -top.speed_per_tc_s * (top.points.reduce((a, p) => a + p[0], 0) / Math.max(top.points.length, 1)),
                  }
                : null
            }
            xLabel="TC with the throttle open, s"
            yLabel="Speed 150 m on, km/h against the same entry speed"
            hint="Point at a pass to read it."
          />
          <View style={styles.legendRow}>
            <LegendItem color={c.s1} label="Quick laps" />
            <LegendItem color={c.other} label="Other clean laps" />
            <LegendItem color={c.ink2} label="Trend" kind="dash" />
          </View>
          <Text style={styles.caption}>
            {top.speed_per_tc_s != null
              ? `${signedR(top.speed_per_tc_s)} km/h per second of TC at the same entry speed (r ${signedR(top.speed_r)}).`
              : ''}
          </Text>
        </>
      )}
      <Text style={styles.h3}>TC against rear tyre temperature</Text>
      {temp && laps.length > 0 ? (
        <>
          <Scatter
            points={laps.map((l) => ({
              x: l.rear_tyre_c as number,
              y: l.tc_s as number,
              color: l.quick ? c.s1 : c.other,
              front: l.quick,
              label: `${l.run} lap ${l.lap} · ${formatLap(l.time)} · rear tyres ${(l.rear_tyre_c as number).toFixed(1)} °C · ${(l.tc_s as number).toFixed(2)} s of TC`,
            }))}
            fit={temp.intercept != null ? { slope: temp.slope, intercept: temp.intercept } : null}
            xLabel="Rear tyre temperature, °C (lap median)"
            yLabel="TC with the throttle open, s a lap"
            hint="Point at a lap to read it."
          />
          <View style={styles.legendRow}>
            <LegendItem color={c.s1} label="Quick laps" />
            <LegendItem color={c.other} label="Other clean laps" />
            <LegendItem color={c.ink2} label="Trend" kind="dash" />
          </View>
          <Text style={styles.caption}>
            {within
              ? `Lap to lap within a run, each °C on the rear tyres goes with ${signedR(within.slope)} s of TC a lap (r ${signedR(within.r)} over ${within.n} laps).`
              : `r ${signedR(temp.r)} over ${temp.n} laps.`}{' '}
            The temperature is the air inside the tyre, from the pressure sensors.
          </Text>
        </>
      ) : laps.length > 0 ? (
        <Text style={styles.dim}>TC against the rear tyre temperature takes 4 laps.</Text>
      ) : (
        <Text style={styles.dim}>No rear tyre temperatures in these logs.</Text>
      )}
      {vt && vt.p < 0.05 && (
        <Text style={styles.note}>
          {vt.r < 0
            ? `More TC goes with quicker laps, not slower ones (r ${signedR(vt.r)}): overall TC is a sign of pushing; the costly places are the ones above.`
            : `More TC goes with slower laps (r ${signedR(vt.r)}).`}
        </Text>
      )}
      {sw && (
        <Text style={styles.caption}>
          {sw.channel === 'NTCStatus'
            ? `TC level on the dash: ${sw.positions.join(', ')} in these laps (a higher number cuts in earlier and more)`
            : `The TC thumb wheel (${sw.channel}) was at ${sw.positions.join(', ')} in these laps: where the wheel sits, which in the logs isn't always the TC number on the dash`}
          {sw.vs_tc
            ? sw.vs_tc.p < 0.05
              ? `; TC time goes with it (r ${signedR(sw.vs_tc.r)}).`
              : `; it shows no clear link to how much TC works (r ${signedR(sw.vs_tc.r)}).`
            : '.'}
        </Text>
      )}
      {tc.notes.map((n) => (
        <Text key={n} style={styles.caption}>
          {n}
        </Text>
      ))}
    </View>
  );
}

const useStyles = themed((c) => ({
  wrap: { gap: 20 },
  block: { gap: 8 },
  loading: { gap: 8, paddingVertical: 16 },
  h2: { fontSize: 20, fontWeight: '700' },
  h3: { ...Type.label, fontSize: 13, color: c.text, borderTopWidth: 3, borderColor: c.rule, paddingTop: 6, marginTop: 8 },
  dim: { ...Type.dek, fontSize: 16, lineHeight: 22, color: c.textSecondary },
  error: { color: c.error },
  bold: { fontWeight: '700' },
  caption: { fontFamily: Fonts.label, fontSize: 12, lineHeight: 16, color: c.textMuted },
  note: { lineHeight: 20 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { flexGrow: 1, flexBasis: 260, gap: 4, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10 },
  tileLabel: { ...Type.label, color: c.text },
  tileValue: { fontFamily: Fonts.display, fontSize: 46, lineHeight: 50, color: c.text },
  tileDetail: { fontSize: 13, opacity: 0.8, lineHeight: 18 },
  tileAction: { fontSize: 14, lineHeight: 20, marginTop: 4 },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  legendText: { fontSize: 12, opacity: 0.75 },
  legendDot: { width: 18, height: 12 },
  // the speed bands: 44 px tap targets around their underlined names, the rows far enough apart not to overlap
  tabs: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 6, rowGap: 22 },
  tabHit: { minWidth: TAP, marginRight: 8, ...tapRoom(11) },
  tab: { borderBottomWidth: 3, borderColor: 'transparent', paddingBottom: 2, backgroundColor: 'transparent' },
  tabText: { ...Type.label, fontSize: 13, color: c.textMuted },
  tabOn: { ...Type.label, fontSize: 13, color: c.text },
  trow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 3 },
  th: { ...Type.label, fontSize: 11, color: c.textSecondary },
  td: { fontSize: 13, fontVariant: ['tabular-nums'] },
  num: { textAlign: 'right', paddingRight: 6 },
  center: { textAlign: 'center' },
  tcode: { width: 64 },
  tcell: { flex: 1, marginHorizontal: 1 },
  tworth: { width: 52, textAlign: 'right', fontSize: 12, fontVariant: ['tabular-nums'] },
  cell: { height: 38, alignItems: 'center', justifyContent: 'center' },
  cellValue: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  cellGap: { fontSize: 10, fontVariant: ['tabular-nums'] },
  noteRow: { gap: 2, paddingVertical: 6, borderBottomWidth: 1, borderColor: c.separator },
  noteHead: { fontSize: 14 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 24 },
  fact: { gap: 2 },
  factValue: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 34, color: c.text },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  verdictCol: { flexGrow: 1, flexShrink: 1, minWidth: 100, maxWidth: 140, paddingLeft: 10 },
  subtle: { fontSize: 11, opacity: 0.6, fontVariant: ['tabular-nums'] },
  badgeText: { fontSize: 12 },
  zoneCard: { gap: 6, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10 },
  zoneHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
}));
