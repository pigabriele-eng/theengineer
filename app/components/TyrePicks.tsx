// Tyres for each stint (Gabriele, 2026-10-08: "when uploading a stint you can add a check for tires 'new, fresh, used,
// very used'"). Right under an upload's result, one row per stint of the upload in the order they ran, named as the
// event page names it, with its driver: New · Fresh · Used · Very used, the app's guess ticked and marked as a guess
// (with its short why) until the driver taps. A tap saves that row at once; "Confirm all" saves every row still a guess
// (lib/tyrePicks.ts confirmAll: never over a pick the driver made); leaving it changes nothing. The same row opens
// under a run from the tyres tag on its row, or from its hold menu (components/TyreTag.tsx). In the programme's way:
// under a thick ink rule, the four levels as the technique check's own picks (components/Picks.tsx Choice), no chips.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { ErrorLine, FormActions, MainButton, Note, Said } from '@/components/Controls';
import { DriverPick, useDriverPick } from '@/components/DriverPick';
import { DriverTag } from '@/components/DriverTag';
import { Choice } from '@/components/Picks';
import { Label, TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { codeOf } from '@/lib/driverTag';
import { eventsOf, eventTyres, setSessionTyres } from '@/lib/eventTyres';
import { TYRE_LABEL, TYRE_LEVELS, TyreLevel } from '@/lib/tyreLevels';
import {
  afterConfirm, choiceSpeech, confirmAll, confirmedWords, guesses, picked, rowNote, TyreRow, TyresPut, uploadRows,
} from '@/lib/tyrePicks';
import { Fonts, themed, Type, useTheme } from '@/constants/Theme';

type Group = { id: number; name: string | null; rows: TyreRow[] };
const NONE: TyreRow[] = [];

const tagOf = (driver: string | null) => (driver ? { text: codeOf(driver)!, kind: 'known' as const, name: driver }
  : { text: 'Driver?', kind: 'none' as const, name: null });

/** One stint: its driver and name (left out under a run's own row: `bare`), the four levels (the one tapped saved at
 * once) and, under them, the guess and why or "Confirmed". `drivers`: "Driver?" opens the run's driver list. */
export function TyreRowView({ row, onPick, saving, error, last, bare, drivers }: {
  row: TyreRow;
  onPick: (level: TyreLevel) => void;
  saving: boolean;
  error: string | null;
  last?: boolean;
  bare?: boolean;
  drivers?: DriverPick;
}) {
  const styles = useStyles();
  const c = useTheme();
  const code = codeOf(row.driver);
  return (
    <View style={last ? styles.rowLast : styles.row}>
      {bare ? null : (
        <View style={styles.rowHead}>
          <DriverTag tag={tagOf(drivers ? drivers.name(row.id, row.driver) : row.driver)} run={row.name}
            onPress={drivers ? () => drivers.toggle(row.id) : undefined} />
          <Text style={styles.rowName} numberOfLines={2}>{row.name}</Text>
        </View>
      )}
      {!bare && drivers?.panel({ id: row.id, name: row.name, driver: row.driver })}
      <View style={styles.levels}>
        {TYRE_LEVELS.map((k) => (
          <Choice key={k} label={TYRE_LABEL[k]} on={row.level === k} disabled={saving} onPress={() => onPick(k)}
            accessibilityLabel={choiceSpeech(row, code, k, TYRE_LABEL[k])} />
        ))}
        {saving ? <ActivityIndicator color={c.text} accessibilityLabel={`Saving the tyres of ${row.name}`} /> : null}
      </View>
      <Text style={row.mine ? styles.confirmed : styles.guess} accessibilityLiveRegion="polite">{rowNote(row)}</Text>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </View>
  );
}

/** The rows' state: each row saved at once when tapped, with its own error. `initial` changes only when the rows are
 * read again. */
function useTyreRows(initial: TyreRow[]) {
  const [rows, setRows] = useState(initial);
  const [saving, setSaving] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});
  useEffect(() => setRows(initial), [initial]);
  const pick = useCallback(async (row: TyreRow, level: TyreLevel) => {
    setSaving((s) => new Set(s).add(row.id));
    setErrors(({ [row.id]: _, ...rest }) => rest);
    try {
      await setSessionTyres(row.id, level);
      setRows((rs) => rs.map((r) => (r.id === row.id ? picked(r, level) : r)));
    } catch (e) {
      setErrors((x) => ({ ...x, [row.id]: `Not saved: ${(e as Error).message}` }));
    } finally {
      setSaving((s) => {
        const n = new Set(s);
        n.delete(row.id);
        return n;
      });
    }
  }, []);
  return { rows, setRows, saving, errors, pick };
}

/** Under an upload's result: the tyres of each stint it brought (`runIds`), grouped by event when it went into more
 * than one. `refresh`: read again (runs were moved to another event). Nothing shows for runs in no event. */
export function UploadTyres({ runIds, refresh }: { runIds: number[]; refresh?: unknown }) {
  const styles = useStyles();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);
  const key = runIds.join(',');

  const read = useCallback(async (): Promise<Group[]> => {
    const ids = key.split(',').filter(Boolean).map(Number);
    const events = await eventsOf(ids);
    const all = await Promise.all(events.map(async (e) => ({ ...e, rows: uploadRows((await eventTyres(e.id)).runs, ids) })));
    return all.filter((g) => g.rows.length > 0);
  }, [key]);

  useEffect(() => {
    if (!key) return;
    let live = true;
    read().then((g) => live && setGroups(g), () => live && setGroups([])); // an older server: no rows
    return () => {
      live = false;
    };
  }, [read, refresh]);

  const rows = useMemo(() => groups?.flatMap((g) => g.rows) ?? NONE, [groups]);
  const state = useTyreRows(rows);
  // the rows as shown (taps saved since included), back into their events
  const shown = (groups ?? []).map((g) => ({ ...g, rows: state.rows.filter((r) => g.rows.some((x) => x.id === r.id)) }));

  if (!groups || !rows.length) return null;
  if (skipped) {
    return <Note style={styles.skipped}>Tyres left as guessed: tap a run’s tyres on its row to change them.</Note>;
  }

  const confirm = async () => {
    setBusy(true);
    setSaid(null);
    let now: TyreRow[] = [];
    try {
      now = (await read()).flatMap((g) => g.rows); // a pick made elsewhere since is the driver's: kept
    } catch {
      // can't read them again: the rows as shown, the driver's picks among them kept
    }
    const puts = confirmAll(state.rows, now);
    const saved: TyresPut[] = [];
    let failed = 0;
    for (const p of puts) { // one at a time: each sets the run's tyres and queues its event's check again
      try {
        await setSessionTyres(p.id, p.tyres);
        saved.push(p);
      } catch {
        failed += 1;
      }
    }
    state.setRows((rs) => afterConfirm(rs, saved, now));
    setSaid({ text: confirmedWords(saved.length, failed), error: failed > 0 });
    setBusy(false);
  };

  const left = guesses(state.rows);
  return (
    <View style={styles.box}>
      <Label>Tyres</Label>
      <Text style={styles.title} accessibilityRole="header">Tyres for each stint</Text>
      <Note>
        {left > 0 ? 'The app’s guess is ticked. Tap the right level to save a stint’s, or confirm them all; left alone, '
          + 'the guesses stay.' : 'Tap another level to change a stint’s tyres.'}
      </Note>
      {shown.map((g) => (
        <EventRows key={g.id} group={g} named={shown.length > 1} busy={busy} state={state} />
      ))}
      {said ? <Said text={said.text} error={said.error} /> : null}
      {left > 0 ? (
        <FormActions>
          <MainButton label="Confirm all" onPress={confirm} busy={busy}
            sub={left === state.rows.length ? null : `${left} still a guess`} />
          <TextLink label="Skip" onPress={() => setSkipped(true)} />
        </FormActions>
      ) : !said ? <Note>Every stint’s tyres are confirmed.</Note> : null}
    </View>
  );
}

/** One event's stints, their "Driver?" a tap to set (the event's drivers offered first). */
function EventRows({ group, named, busy, state }: {
  group: Group;
  named: boolean;
  busy: boolean;
  state: ReturnType<typeof useTyreRows>;
}) {
  const styles = useStyles();
  const drivers = useDriverPick(group.id);
  return (
    <View style={styles.group}>
      {named && group.name ? <Label style={styles.event}>{group.name}</Label> : null}
      {group.rows.map((r, i) => (
        <TyreRowView key={r.id} row={r} last={i === group.rows.length - 1} saving={busy || state.saving.has(r.id)}
          error={state.errors[r.id] ?? null} onPick={(k) => state.pick(r, k)} drivers={drivers} />
      ))}
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { gap: 10, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10, marginTop: 18, maxWidth: 760 },
  title: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 31, textTransform: 'uppercase', color: c.text },
  group: { borderTopWidth: 1, borderColor: c.rule, marginTop: 4 },
  event: { marginTop: 10 },
  row: { paddingVertical: 12, gap: 8, borderBottomWidth: 1, borderColor: c.separator },
  rowLast: { paddingVertical: 12, gap: 8 },
  rowHead: { flexDirection: 'row', alignItems: 'baseline', columnGap: 10 },
  rowName: { fontFamily: Type.label.fontFamily, fontSize: 17, letterSpacing: 0.3, color: c.text, flexShrink: 1 },
  levels: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 6 },
  guess: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.textSecondary },
  confirmed: { fontFamily: Type.label.fontFamily, fontSize: 16, lineHeight: 22, letterSpacing: 0.3, color: c.text },
  skipped: { marginTop: 18 },
}));
