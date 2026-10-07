import { Stack, useLocalSearchParams } from 'expo-router';
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { Block, Colophon, Label, Page, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import {
  Actions,
  ErrorLine,
  Field,
  MainAction,
  Note,
  Opening,
  Options,
  Stepper,
  SubHead,
  WarnLine,
  Working,
} from '@/components/ToolForm';
import { api, formatLap, Session } from '@/lib/api';
import { toolLists, VehicleItem } from '@/lib/toolLists';
import {
  History,
  HistoryRun,
  Observation,
  POSITION_LABEL,
  runDate,
  setupApi,
  Sheet,
  showValue,
  signed,
  Suggestion,
  Suggestions,
  Template,
  TemplateRow,
} from '@/lib/setup';
import { face, Fonts, inkOn, themed, Type, useTheme } from '@/constants/Theme';

type Tab = 'sheet' | 'runs' | 'ideas';
const TABS: { value: Tab; label: string }[] = [
  { value: 'sheet', label: 'Sheet' },
  { value: 'runs', label: 'Runs' },
  { value: 'ideas', label: 'Suggestions' },
];

// Setup: a sheet per session on the car's template, what changed from run to run against lap time and balance,
// and setup changes to try from the driver's feedback. Open with ?session=<id> (and &tab=runs or ideas).
export default function SetupScreen() {
  const styles = useStyles();
  const params = useLocalSearchParams<{ session?: string; tab?: string }>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [withSheets, setWithSheets] = useState<Set<number>>(new Set());
  const [picked, setPicked] = useState<number | null>(params.session ? Number(params.session) : null);
  const [tab, setTab] = useState<Tab>(params.tab === 'runs' || params.tab === 'ideas' ? params.tab : 'sheet');
  const [error, setError] = useState<string | null>(null);

  const refreshSheets = useCallback(() => {
    setupApi.withSheets().then((rows) => setWithSheets(new Set(rows.map((r) => r.session_id))), () => {});
  }, []);

  useEffect(() => {
    api.sessions().then(
      (s) => {
        setSessions(s);
        setPicked((p) => p ?? s[0]?.id ?? null);
      },
      (e) => setError(e.message),
    );
    refreshSheets();
  }, [refreshSheets]);

  // the garage's vehicles, and the run's own (its event's, else its car's): picked by default
  const [vehicles, setVehicles] = useState<VehicleItem[]>([]);
  const [runVehicle, setRunVehicle] = useState<number | null>(null);
  const [vehicleId, setVehicleId] = useState<number | null>(null);
  useEffect(() => {
    if (picked == null) return;
    let live = true;
    toolLists.vehicles(picked).then(
      (r) => {
        if (!live) return;
        setVehicles(r.vehicles);
        setRunVehicle(r.session_vehicle_id);
        setVehicleId(r.session_vehicle_id);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [picked]);
  const vehicle = vehicles.find((v) => v.id === vehicleId) ?? null;

  const pick = (id: number, next: Tab = tab) => {
    setPicked(id);
    setTab(next);
  };
  const current = sessions.find((s) => s.id === picked);
  const eventId = (current as (Session & { event_id?: number | null }) | undefined)?.event_id ?? null;

  return (
    <Page keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: current ? `Setup · ${current.name ?? `Session ${current.id}`}` : 'Setup' }} />
      <Opening title={current ? `Setup · ${current.name ?? `Session ${current.id}`}` : 'Setup'}
        dek="One setup sheet per run. Copy the last run and change what you changed, then see it against lap time and balance, and get setup changes to try from the debrief and the data." />

      <View style={styles.runs}>
        <SubHead>Run</SubHead>
        {sessions.length > 0 && (
          <Options label="Run" value={picked} onPick={(id) => pick(id)}
            options={sessions.map((s) => ({
              value: s.id,
              label: s.name ?? `Session ${s.id}`,
              sub: `${formatLap(s.best_lap_s)}${withSheets.has(s.id) ? ' · sheet' : ''}`,
            }))} />
        )}
        {sessions.length === 0 && !error && <Note small>No sessions yet. Import a test first.</Note>}
        {error ? <ErrorLine>{error}</ErrorLine> : null}
      </View>

      <View style={styles.tabs}>
        <Options big label="Setup" value={tab} onPick={setTab} options={TABS} />
      </View>

      {picked != null && tab !== 'runs' && (
        <Section no={1} title="Vehicle" dek="Its stored specs are what the vehicle model and the suggestions start from, and a new sheet takes its template.">
          <VehiclePicker vehicles={vehicles} vehicleId={vehicleId} runVehicle={runVehicle} eventId={eventId}
            onPick={setVehicleId} />
        </Section>
      )}
      {picked != null && tab === 'sheet' && (
        <SheetEditor key={picked} sessionId={picked} vehicle={vehicle} onSaved={refreshSheets} />
      )}
      {picked != null && tab === 'runs' && (
        <RunsView key={picked} sessionId={picked} onPick={(id) => pick(id, 'sheet')} />
      )}
      {picked != null && tab === 'ideas' && <IdeasView key={picked} sessionId={picked} vehicleId={vehicleId} />}

      <Colophon left="The Engineer · Setup" links={[
        { label: 'Vehicle model', href: '/tools/vehicle' },
        { label: 'Tyre pressures', href: '/tools/pressures' },
        { label: 'Garage', href: '/garage' },
      ]} />
    </Page>
  );
}

// ---------- the sheet ----------

const toForm = (values: Record<string, number>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]));

// The vehicle the setup goes with: the run's own by default (set on its event or car), or another picked here. Its
// stored specs are what the vehicle model and the suggestions start from, and a new sheet takes its template.
function VehiclePicker({
  vehicles,
  vehicleId,
  runVehicle,
  eventId,
  onPick,
}: {
  vehicles: VehicleItem[];
  vehicleId: number | null;
  runVehicle: number | null;
  eventId: number | null;
  onPick: (id: number | null) => void;
}) {
  const styles = useStyles();
  const own = vehicles.find((v) => v.id === runVehicle);
  return (
    <View style={styles.stack}>
      {vehicles.length === 0 ? (
        <Note>No vehicles in the garage yet: the sheet’s built-in car values are used.</Note>
      ) : (
        <Options label="Vehicle" value={vehicleId} onPick={(id) => onPick(id === vehicleId ? runVehicle : id)}
          options={vehicles.map((v) => ({ value: v.id, label: v.name, sub: v.id === runVehicle ? 'this run’s' : undefined }))} />
      )}
      {vehicles.length > 0 &&
        (own == null ? (
          <Note small>
            This run has no vehicle set
            {eventId != null ? ': set it on the event (or link the car to its vehicle in the garage).'
              : ': link its car to its vehicle in the garage.'}
          </Note>
        ) : vehicleId !== own.id ? (
          <Note small>Picked here only: this run’s vehicle is {own.name}.</Note>
        ) : (
          <Note small>This run’s vehicle: its specs feed the vehicle model and the suggestions.</Note>
        ))}
      <View style={styles.links}>
        {vehicles.length > 0 && own == null && eventId != null && (
          <TextLink small arrow label="Set it on the event" href={{ pathname: '/event/[id]', params: { id: eventId } }} />
        )}
        <TextLink small arrow label="Add a vehicle in the garage" href="/garage" />
      </View>
    </View>
  );
}

function SheetEditor({
  sessionId,
  vehicle,
  onSaved,
}: {
  sessionId: number;
  vehicle: VehicleItem | null;
  onSaved: () => void;
}) {
  const styles = useStyles();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [templates, setTemplates] = useState<{ key: string; name: string }[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmCopy, setConfirmCopy] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = (s: Sheet) => {
    setSheet(s);
    setForm(toForm(s.values));
    setNotes(s.notes ?? '');
    setDirty(false);
    setConfirmCopy(false);
    // a copy nobody has changed yet (made here or from the session page)
    const from = s.copied_from_session_id === s.previous?.session_id ? s.previous?.name : null;
    setMessage(from && s.changes.length === 0 ? `Copied from ${from}: change what you changed, then save` : null);
  };

  useEffect(() => {
    let live = true;
    setupApi.sheet(sessionId).then(
      (s) => live && show(s),
      (e) => live && setError(e.message),
    );
    setupApi.templates().then((t) => live && setTemplates(t), () => {});
    return () => {
      live = false;
    };
  }, [sessionId]);

  // a new sheet takes the template the picked vehicle's name points to (a vehicle that points to none leaves the
  // run's own)
  const exists = sheet?.exists;
  useEffect(() => {
    if (vehicle && vehicle.template !== 'generic' && exists === false)
      setSheet((s) => (s && !s.exists ? { ...s, template: vehicle.template } : s));
  }, [vehicle?.template, exists]);

  useEffect(() => {
    if (!sheet) return;
    setupApi.template(sheet.template).then(setTemplate, (e) => setError(e.message));
  }, [sheet?.template]);

  const setField = (key: string, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
    setMessage(null);
  };

  const fieldLabel = (row: TemplateRow, at: string | null) => (at ? `${row.label} ${POSITION_LABEL[at]}` : row.label);

  const save = async () => {
    if (!template || !sheet) return;
    const values: Record<string, number | null> = {};
    for (const g of template.groups)
      for (const row of g.rows)
        for (const f of row.fields) {
          const raw = (form[f.key] ?? '').trim().replace(',', '.');
          if (raw === '') {
            values[f.key] = null;
            continue;
          }
          const x = Number(raw);
          if (!Number.isFinite(x)) {
            setError(`Check "${fieldLabel(row, f.at)}"`);
            return;
          }
          values[f.key] = x;
        }
    setBusy(true);
    setError(null);
    try {
      show(await setupApi.save(sessionId, { template: template.key, values, notes }));
      setMessage('Saved');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (sheet?.exists && Object.keys(sheet.values).length && !confirmCopy) {
      setConfirmCopy(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      show(await setupApi.copyPrevious(sessionId));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const prev = sheet?.previous && sheet.previous.template === template?.key ? sheet.previous.values : null;
  const filled = useMemo(() => Object.values(form).filter((v) => v.trim() !== '').length, [form]);

  if (!sheet || !template) {
    return (
      <Section no={2} title="The sheet">
        {error ? <ErrorLine>{error}</ErrorLine> : <Working>Reading the sheet…</Working>}
      </Section>
    );
  }

  const actions = (bottom?: boolean) => (
    <Actions style={bottom ? styles.sheetActionsBottom : styles.sheetActions}>
      <MainAction label="Save" onPress={save} busy={busy} />
      {sheet.previous && (
        <TextLink onPress={copy} disabled={busy}
          label={confirmCopy ? 'Tap again to replace this sheet' : `Copy from ${sheet.previous.name ?? 'previous run'}`}
          red={confirmCopy} />
      )}
      {dirty && <Note small>Unsaved changes</Note>}
      {message && !dirty ? <Text style={styles.saved}>{message}</Text> : null}
    </Actions>
  );

  return (
    <Section no={2} title="The sheet"
      dek={`${template.name}. ${sheet.exists ? `${filled} values` : 'No sheet for this run yet'}${sheet.previous ? `; the previous run with a sheet is ${sheet.previous.name ?? `session ${sheet.previous.session_id}`}` : ''}.`}>
      {!sheet.exists && templates.length > 1 && (
        <View style={styles.templates}>
          <Label small muted>Template</Label>
          <Options label="Template" value={template.key} onPick={(key) => setSheet({ ...sheet, template: key })}
            options={templates.map((t) => ({ value: t.key, label: t.name }))} />
        </View>
      )}

      {actions()}
      {error ? <View style={styles.gapTop}><ErrorLine>{error}</ErrorLine></View> : null}

      {sheet.changes.length > 0 && !dirty && (
        <View style={styles.changes}>
          <SubHead>Changed from {sheet.previous?.name ?? 'the previous run'}</SubHead>
          {sheet.changes.map((c) => (
            <Text key={c.key} style={styles.changeLine}>{c.text}</Text>
          ))}
        </View>
      )}
      {sheet.warnings.length > 0 && !dirty && (
        <View style={styles.changes}>
          {sheet.warnings.map((w) => <WarnLine key={w.key}>{w.text}</WarnLine>)}
        </View>
      )}

      <View style={styles.links}>
        <TextLink small onPress={() => setShowSources((s) => !s)}
          label={showSources ? 'Hide where each item comes from' : 'Show where each item comes from'} />
        {sheet.exists && (template.vehicle_preset || vehicle) && (
          <TextLink small arrow label="Open in the vehicle model"
            href={{ pathname: '/tools/vehicle', params: vehicle ? { session: sessionId, vehicle: vehicle.id } : { session: sessionId } }} />
        )}
      </View>

      {template.groups.map((g) => (
        <View key={g.name} style={styles.group}>
          <SubHead>{g.name}</SubHead>
          {g.rows.map((row) => (
            <RowEditor key={row.key} row={row} form={form} prev={filled > 0 ? prev : null} showSources={showSources}
              setField={setField} />
          ))}
        </View>
      ))}

      <View style={styles.group}>
        <SubHead>Notes</SubHead>
        <Field boxed value={notes} multiline keyboardType="default" accessibilityLabel="Notes"
          onChangeText={(t) => {
            setNotes(t);
            setDirty(true);
          }}
          placeholder="Anything else about this run’s setup" inputStyle={styles.notes} />
      </View>
      {actions(true)}
    </Section>
  );
}

function RowEditor({
  row,
  form,
  prev,
  showSources,
  setField,
}: {
  row: TemplateRow;
  form: Record<string, string>;
  prev: Record<string, number> | null;
  showSources: boolean;
  setField: (key: string, value: string) => void;
}) {
  const styles = useStyles();
  const wide = useWide();
  // four corners, or options, go under the name on a phone; one or two values sit beside it
  const under = !wide && (row.layout === 'corner' || row.kind === 'choice');
  const unit = [row.unit && row.kind !== 'choice' ? row.unit : '', row.confidence !== 'published' ? row.confidence : '']
    .filter(Boolean).join(' · ');
  return (
    <View style={styles.row}>
      <View style={under ? undefined : styles.rowLine}>
        <View style={under ? styles.rowNameUnder : styles.rowName}>
          <Text style={styles.rowLabel}>{row.label}</Text>
          {unit ? <Text style={styles.rowUnit}>{unit}</Text> : null}
        </View>
        <View style={under ? (row.layout === 'corner' ? styles.cellsCorner : styles.cellsUnder)
          : row.kind === 'choice' ? styles.cellsChoice : styles.cells}>
          {row.fields.map((f) => {
            const value = form[f.key] ?? '';
            const before = prev?.[f.key];
            const now = value.trim() === '' ? null : Number(value.replace(',', '.'));
            const changed = prev != null && (before ?? null) !== now;
            return (
              <View key={f.key} style={under && row.layout === 'corner' ? styles.cellHalf : styles.cell}>
                {f.at ? <Text style={styles.at}>{POSITION_LABEL[f.at]}</Text> : null}
                <FieldInput row={row} at={f.at} value={value} changed={changed} onChange={(v) => setField(f.key, v)} />
                {changed ? <Text style={styles.was}>was {showValue(row, before)}</Text> : null}
              </View>
            );
          })}
        </View>
      </View>
      {showSources && row.note ? <Text style={styles.source}>{row.note}</Text> : null}
    </View>
  );
}

function FieldInput({
  row,
  at,
  value,
  changed,
  onChange,
}: {
  row: TemplateRow;
  at: string | null;
  value: string;
  changed: boolean;
  onChange: (v: string) => void;
}) {
  const name = at ? `${row.label} ${POSITION_LABEL[at]}` : row.label;
  if (row.kind === 'choice') {
    return (
      <Options label={name} value={value === '' ? null : Number(value)}
        onPick={(v) => onChange(value === String(v) ? '' : String(v))}
        options={row.options.map((o) => ({ value: o.value, label: o.label }))} />
    );
  }
  if (row.kind === 'position') {
    const n = value.trim() === '' ? null : Number(value);
    const lo = row.min ?? 0;
    const step = (d: number) => {
      let next = n == null ? (d > 0 ? lo : row.max ?? lo) : n + d;
      if (next < lo) next = lo;
      if (row.max != null && next > row.max) next = row.max;
      onChange(String(next));
    };
    return <Stepper label={name} value={n == null ? '–' : String(n)} of={row.max != null ? `/${row.max}` : undefined} onStep={step} />;
  }
  return (
    <Field width={84} align="right" value={value} onChangeText={onChange} keyboardType="numbers-and-punctuation"
      selectTextOnFocus placeholder="–" marked={changed} accessibilityLabel={`${name}${row.unit ? `, ${row.unit}` : ''}`} />
  );
}

// ---------- runs against results ----------

function RunsView({ sessionId, onPick }: { sessionId: number; onPick: (id: number) => void }) {
  const styles = useStyles();
  const [hist, setHist] = useState<History | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let h = await setupApi.history(sessionId);
        if (!live) return;
        setHist(h);
        // Each run's balance is read from its log once (one log at a time), then kept on the server.
        const todo = h.runs.filter((r) => r.needs_summary);
        for (let i = 0; i < todo.length; i++) {
          setProgress({ done: i, total: todo.length });
          await setupApi.results(todo[i].session_id).catch(() => null);
          if (!live) return;
          h = await setupApi.history(sessionId);
          if (!live) return;
          setHist(h);
        }
        setProgress(null);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId]);

  const estimated = hist?.runs.some((r) => r.summary?.steering?.confidence === 'estimate') ?? false;
  return (
    <Section no={1} title="Runs against results"
      dek="Every run of this test in order, each set against the last run before it with a sheet and clean laps: what changed on the car, and what the lap times and the balance did.">
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {!hist && !error && <Working>Reading the runs…</Working>}
      {progress && <Working>Reading the balance from the logs: {progress.done + 1} of {progress.total}</Working>}
      {hist && (
        <View style={styles.runList}>
          {hist.runs.map((r) => (
            <RunBlock key={r.session_id} run={r} current={r.session_id === sessionId} onPick={onPick} />
          ))}
        </View>
      )}
      {hist && (
        <Note small style={styles.gapTop}>
          Best and Top 3 (the mean of the three quickest clean laps), with the change from the run it is compared with:
          green is quicker. The balance is the balance report’s: steering beyond what the corner needs, in road wheel
          degrees. Per g is the car’s own understeer per g of cornering (lower is less understeer overall). Entry (on
          the brakes), mid-corner and exit (on the throttle) are the balance against that normal while cornering on the
          clean laps: + the front pushes more than normal, − the rear slides. TC and ABS: seconds working per clean lap.
          {estimated ? ' The steering ratio behind it is an estimate, so compare runs rather than reading one alone.' : ''}
        </Note>
      )}
    </Section>
  );
}

function RunBlock({ run, current, onPick }: { run: HistoryRun; current: boolean; onPick: (id: number) => void }) {
  const c = useTheme();
  const styles = useStyles();
  const wide = useWide();
  const d = run.deltas;
  const b = run.summary?.balance;
  // a lap time's change: a flat block, green quicker and red slower
  const lapBlock = (x: number | null | undefined) =>
    x == null || Math.abs(x) < 0.005 ? undefined : x < 0 ? c.delta.gain : c.delta.loss;
  return (
    <Pressable onPress={() => onPick(run.session_id)} accessibilityRole="button"
      accessibilityLabel={`${run.name ?? `Session ${run.session_id}`}: open its sheet`}
      style={StyleSheet.flatten([styles.run, current && styles.runCurrent])}>
      <View style={styles.runHead}>
        <Text style={wide ? styles.runName : styles.runNamePhone}>{run.name ?? `Session ${run.session_id}`}</Text>
        {current && <Block label="This run" color={c.rule} ink={c.background} />}
        <Text style={styles.runDate}>{runDate(run.run_time)}</Text>
      </View>
      {run.has_setup ? (
        run.compared_with ? (
          run.changes.length ? (
            <View style={styles.runChanges}>
              <Note small>Changed from {run.compared_with.name}:</Note>
              {run.changes.map((ch) => <Text key={ch.key} style={styles.changeText}>{ch.text}</Text>)}
            </View>
          ) : (
            <Note small>Same setup as {run.compared_with.name}</Note>
          )
        ) : (
          <Note small>First sheet of the test</Note>
        )
      ) : (
        <Note small>No setup sheet</Note>
      )}
      {run.laps.clean_laps === 0 ? (
        <Note small>No clean laps</Note>
      ) : (
        <View style={styles.stats}>
          {/* three groups that wrap as a whole: lap times, balance, driver aids */}
          <View style={styles.statGroup}>
            <Stat label="Best" value={formatLap(run.laps.best_s)} delta={signed(d?.best_s)} fill={lapBlock(d?.best_s)} />
            <Stat label="Top 3" value={formatLap(run.laps.top3_s)} delta={signed(d?.top3_s)} fill={lapBlock(d?.top3_s)} />
            <Stat label="Laps" value={String(run.laps.clean_laps)} />
          </View>
          {b ? (
            <View style={styles.statGroup}>
              <Stat label="Per g" value={fmt(b.gradient_per_g)} delta={signed(d?.balance.gradient_per_g)} />
              <Stat label="Entry" value={fmt(b.entry, true)} delta={signed(d?.balance.entry)} />
              <Stat label="Mid" value={fmt(b.mid, true)} delta={signed(d?.balance.mid)} />
              <Stat label="Exit" value={fmt(b.exit, true)} delta={signed(d?.balance.exit)} />
            </View>
          ) : run.needs_summary ? (
            <View style={styles.statGroup}><Stat label="Balance" value="…" /></View>
          ) : null}
          {(run.summary?.tc_s_per_lap != null || run.summary?.abs_s_per_lap != null) && (
            <View style={styles.statGroup}>
              {run.summary?.tc_s_per_lap != null && (
                <Stat label="TC s" value={run.summary.tc_s_per_lap.toFixed(1)} delta={signed(d?.tc_s_per_lap, 1)} />
              )}
              {run.summary?.abs_s_per_lap != null && (
                <Stat label="ABS s" value={run.summary.abs_s_per_lap.toFixed(1)} delta={signed(d?.abs_s_per_lap, 1)} />
              )}
            </View>
          )}
        </View>
      )}
    </Pressable>
  );
}

// a balance against the car's normal carries its sign; per g is a plain amount
const fmt = (x: number | null | undefined, sign = false) => (x == null ? '–' : sign ? signed(x) : x.toFixed(2));

/** A figure of a run: its label in Archivo capitals, the value in tabular Archivo, and its change from the run it is
 * compared with (a lap time's in a flat green or red block). */
function Stat({ label, value, delta, fill }: { label: string; value: string; delta?: string; fill?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      {delta != null && delta !== '–' ? (
        fill ? (
          <View style={StyleSheet.flatten([styles.statBlock, { backgroundColor: fill }])}>
            <Text style={StyleSheet.flatten([styles.statDelta, { color: inkOn(fill) }])}>{delta}</Text>
          </View>
        ) : (
          <Text style={StyleSheet.flatten([styles.statDelta, styles.statDeltaPlain])}>{delta}</Text>
        )
      ) : null}
    </View>
  );
}

// ---------- suggestions ----------

function IdeasView({ sessionId, vehicleId }: { sessionId: number; vehicleId: number | null }) {
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
      <Section no={2} title="Setup changes to try" dek={dek}>
        {error ? <ErrorLine>{error}</ErrorLine> : <Working>Reading the debrief and the data…</Working>}
      </Section>
    );
  }
  const said = data.observations.filter((o) => o.source === 'driver');
  const other = data.observations.filter((o) => o.source !== 'driver');
  let no = 2;
  return (
    <>
      <Section no={no} title="Setup changes to try" dek={dek}>
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
        {data.suggestions.map((s) => <Idea key={s.lever} s={s} />)}
      </Section>
      {said.length > 0 && (
        <Section no={++no} title="What the driver said" dek="Each remark, and what the data make of it.">
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
        </Section>
      )}
      {data.measured.length + other.length > 0 && (
        <Section no={++no} title="What the data show"
          dek="Each corner’s balance against the car’s normal where it is clear (0.8° or more), and where traction control or rear wheel slip says the rear can’t take the power.">
          {[...data.measured, ...other].map((o, i) => (
            <Text key={i} style={StyleSheet.flatten([styles.measured, i === 0 && styles.measuredFirst])}>{o.text || o.label}</Text>
          ))}
        </Section>
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
  runs: { marginTop: 22 },
  tabs: { marginTop: 22, borderBottomWidth: 1, borderColor: c.rule },
  stack: { gap: 12 },
  links: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 10, marginTop: 4 },
  gapTop: { marginTop: 12 },
  templates: { gap: 8, marginBottom: 6 },
  sheetActions: { marginTop: 4, marginBottom: 18 },
  sheetActionsBottom: { marginTop: 22 },
  saved: { ...Type.label, fontSize: 12, color: c.success },
  changes: { marginBottom: 18, gap: 4 },
  changeLine: { fontFamily: Fonts.label, fontSize: 15, lineHeight: 20, color: c.text, borderBottomWidth: 1,
    borderColor: c.separator, paddingVertical: 5 },
  group: { marginTop: 26 },
  notes: { minHeight: 90 },

  // a line of the sheet
  row: { borderBottomWidth: 1, borderColor: c.separator, paddingTop: 9, paddingBottom: 10 },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  rowName: { flex: 1, minWidth: 0 },
  rowNameUnder: { marginBottom: 8 },
  rowLabel: { fontFamily: Fonts.label, fontSize: 15, lineHeight: 19, color: c.text },
  rowUnit: { fontFamily: Fonts.label, fontSize: 12, lineHeight: 16, color: c.textMuted, marginTop: 1 },
  cells: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', columnGap: 18, rowGap: 10 },
  cellsChoice: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', columnGap: 44, rowGap: 10 },
  cellsUnder: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 10 },
  cellsCorner: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 },
  cell: { alignItems: 'flex-start', minWidth: 84 },
  cellHalf: { width: '50%', alignItems: 'flex-start', paddingRight: 14 },
  at: { ...Type.label, fontFamily: Fonts.label, fontSize: 10, letterSpacing: 1.2, color: c.textMuted, marginBottom: 2 },
  was: { fontFamily: Fonts.label, fontSize: 12, fontVariant: ['tabular-nums'], color: c.textSecondary, marginTop: 3 },
  source: { fontFamily: Type.dek.fontFamily, fontSize: 14, lineHeight: 19, color: c.textSecondary, marginTop: 6 },

  // runs
  runList: { borderTopWidth: 1, borderColor: c.rule },
  run: { borderBottomWidth: 1, borderColor: c.rule, paddingTop: 14, paddingBottom: 16, gap: 6 },
  runCurrent: { borderBottomWidth: 3 },
  runHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 12, rowGap: 4 },
  runName: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, textTransform: 'uppercase', color: c.text },
  runNamePhone: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 28, textTransform: 'uppercase', color: c.text },
  runDate: { ...Type.label, fontFamily: Fonts.label, fontSize: 12, color: c.textSecondary, marginLeft: 'auto' },
  runChanges: { gap: 2 },
  changeText: { fontFamily: Type.label.fontFamily, fontSize: 15, lineHeight: 21, color: c.text },
  stats: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 30, rowGap: 12, marginTop: 6 },
  statGroup: { flexDirection: 'row', columnGap: 18, borderTopWidth: 1, borderColor: c.rule, paddingTop: 6 },
  stat: { minWidth: 52 },
  statLabel: { ...Type.label, fontFamily: Fonts.label, fontSize: 10, letterSpacing: 1.1, color: c.textSecondary },
  statValue: { fontFamily: Fonts.mono, fontSize: 18, lineHeight: 23, fontVariant: ['tabular-nums'], color: c.text },
  statBlock: { alignSelf: 'flex-start', paddingHorizontal: 5, paddingTop: 1, marginTop: 2 },
  statDelta: { fontFamily: Fonts.mono, fontSize: 13, lineHeight: 17, fontVariant: ['tabular-nums'] },
  statDeltaPlain: { color: c.textSecondary, marginTop: 2 },

  // suggestions
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
