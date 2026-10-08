// The event report's filter (Gabriele, 2026-10-08: "we have to add a way to filter"): which runs' laps go into the
// comparison, picked by tyres, official session and driver. Nothing picked: the report as the server groups it, each
// tyre level on its own. Picked: the server works the report out again for just those runs (GET
// /reports/events/{id}/pick).
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Choice, useText } from '@/components/Picks';
import { Label } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { face, themed } from '@/constants/Theme';
import { anyPicked, countsFor, FilterPicks, FilterRun, flip, NO_PICKS, pickedRuns } from '@/lib/lapFilter';
import { EventTyres, fetchEventTyres } from '@/lib/report';
import { EventParts, fetchParts } from '@/lib/sessionReports';
import { TYRE_LABEL, TYRE_LEVELS, TyreLevel } from '@/lib/tyreLevels';

export default function LapFilter({ eventId, onRuns, style }: {
  eventId: number;
  onRuns: (runs: number[] | null) => void; // the runs picked; null: nothing picked, the automatic grouping
  style?: object;
}) {
  const t = useText();
  const styles = useStyles();
  const [tyres, setTyres] = useState<EventTyres | null>(null);
  const [parts, setParts] = useState<EventParts | null>(null);
  const [picks, setPicks] = useState<FilterPicks>(NO_PICKS);

  useEffect(() => {
    let live = true;
    fetchEventTyres(eventId).then((x) => live && setTyres(x)).catch(() => undefined);
    fetchParts(eventId).then((x) => live && setParts(x)).catch(() => undefined);
    return () => { live = false; };
  }, [eventId]);

  // each run with its tyres, official session and driver
  const runs: FilterRun[] = useMemo(() => {
    if (!tyres) return [];
    const partOf = new Map<number, string>();
    for (const p of parts?.parts ?? []) for (const r of p.runs) partOf.set(r.id, p.code);
    return tyres.runs.map((r) => ({ id: r.id, tyres: r.tyres?.tyres ?? null, part: partOf.get(r.id) ?? null,
      driver: r.driver }));
  }, [tyres, parts]);
  const levels = TYRE_LEVELS.filter((k) => runs.some((r) => r.tyres === k));
  const sessions = (parts?.parts ?? []).filter((p) => runs.some((r) => r.part === p.code));
  const drivers = [...new Set(runs.map((r) => r.driver).filter((d): d is string => d != null))];
  const picked = useMemo(() => (anyPicked(picks) ? pickedRuns(runs, picks) : null), [runs, picks]);

  // the report follows the picks, a moment after the last tap (each pick is worked out on the server)
  const key = picked ? picked.join(',') : '';
  useEffect(() => {
    const id = setTimeout(() => onRuns(picked && picked.length ? picked : null), 900);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!tyres || runs.length < 2) return null;
  const row = (title: string, name: keyof FilterPicks, values: { key: string; label: string }[]) => {
    if (values.length < 2) return null; // nothing to choose
    const counts = countsFor(runs, picks, name, values.map((v) => v.key));
    return (
      <View style={styles.row} accessibilityRole="toolbar" accessibilityLabel={`Pick by ${title.toLowerCase()}`}>
        <Text style={styles.rowTitle}>{title}</Text>
        <View style={styles.choices}>
          {values.map((v) => (
            <Choice key={v.key} label={v.label} detail={String(counts[v.key])} on={picks[name].includes(v.key)}
              dim={counts[v.key] === 0} onPress={() => setPicks((p) => flip(p, name, v.key))}
              accessibilityLabel={`${v.label}: ${counts[v.key]} run${counts[v.key] === 1 ? '' : 's'}`} />
          ))}
        </View>
      </View>
    );
  };
  return (
    <View style={StyleSheet.flatten([styles.box, style])}>
      <Label small>Pick the laps to compare</Label>
      {row('Tyres', 'tyres', levels.map((k: TyreLevel) => ({ key: k, label: TYRE_LABEL[k] })))}
      {row('Session', 'parts', sessions.map((p) => ({ key: p.code, label: p.title })))}
      {row('Driver', 'drivers', drivers.map((d) => ({ key: d, label: d })))}
      <View style={styles.foot}>
        <Text style={t.body}>
          {picked == null ? 'Nothing picked: each tyre level is compared on its own, as the tabs above show.'
            : picked.length === 0 ? 'No run is on all of those. Take one off.'
              : `${picked.length} run${picked.length === 1 ? '' : 's'} picked: the report below is worked out for ` +
                'just their laps.'}
        </Text>
        {picked != null && <Choice label="Clear" on={false} onPress={() => setPicks(NO_PICKS)}
          accessibilityLabel="Clear the picks: back to each tyre level on its own" />}
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { gap: 12, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.rule },
  row: { gap: 6 },
  rowTitle: { fontFamily: face('label', 400), fontSize: 16, color: c.textSecondary },
  choices: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, rowGap: 8 },
  foot: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 8 },
}));
