import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { api, formatLap, Session } from '@/lib/api';
import {
  History,
  HistoryRun,
  POSITION_LABEL,
  runDate,
  setupApi,
  Sheet,
  showValue,
  signed,
  Suggestions,
  Template,
  TemplateRow,
} from '@/lib/setup';

type Tab = 'sheet' | 'runs' | 'ideas';
const TABS: [Tab, string][] = [
  ['sheet', 'Sheet'],
  ['runs', 'Runs'],
  ['ideas', 'Suggestions'],
];
const FASTER = '#2e9d57';
const SLOWER = '#c8372d';
const WARN = '#b26b00';

// Setup: a sheet per session on the car's template, what changed from run to run against lap time and balance,
// and setup changes to try from the driver's feedback. Open with ?session=<id> (and &tab=runs or ideas).
export default function SetupScreen() {
  const params = useLocalSearchParams<{ session?: string; tab?: string }>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [withSheets, setWithSheets] = useState<Set<number>>(new Set());
  const [picked, setPicked] = useState<number | null>(params.session ? Number(params.session) : null);
  const [tab, setTab] = useState<Tab>(params.tab === 'runs' || params.tab === 'ideas' ? params.tab : 'sheet');
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');
  const chipScroll = useRef<ScrollView>(null);
  const scrolled = useRef(false);

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

  const pick = (id: number, next: Tab = tab) => {
    setPicked(id);
    setTab(next);
  };
  const current = sessions.find((s) => s.id === picked);

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: current ? `Setup · ${current.name ?? `Session ${current.id}`}` : 'Setup' }} />
      <Text style={styles.intro}>
        One setup sheet per run. Copy the last run and change what you changed, then see it against lap time and
        balance, and get setup changes to try from the debrief.
      </Text>

      <ScrollView
        ref={chipScroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}>
        {sessions.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => pick(s.id)}
            // the run opened from a session page may sit far along the strip: bring it into view once
            onLayout={(e) => {
              if (s.id === picked && !scrolled.current) {
                scrolled.current = true;
                chipScroll.current?.scrollTo({ x: Math.max(0, e.nativeEvent.layout.x - 16), animated: false });
              }
            }}
            style={[styles.chip, s.id === picked && { borderColor: tint }]}>
            <Text style={s.id === picked ? { color: tint } : undefined}>{s.name ?? `Session ${s.id}`}</Text>
            <Text style={styles.chipSub}>
              {formatLap(s.best_lap_s)}
              {withSheets.has(s.id) ? ' · sheet' : ''}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {sessions.length === 0 && !error && <Text style={styles.dim}>No sessions yet. Import a test first.</Text>}
      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.tabs}>
        {TABS.map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => setTab(key)}
            style={[styles.tab, tab === key && { borderColor: tint, backgroundColor: 'transparent' }]}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === key }}>
            <Text style={[styles.tabText, tab === key && { color: tint }]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {picked != null && tab === 'sheet' && <SheetEditor key={picked} sessionId={picked} onSaved={refreshSheets} />}
      {picked != null && tab === 'runs' && (
        <RunsView key={picked} sessionId={picked} onPick={(id) => pick(id, 'sheet')} />
      )}
      {picked != null && tab === 'ideas' && <IdeasView key={picked} sessionId={picked} />}
    </ScrollView>
  );
}

// ---------- the sheet ----------

const toForm = (values: Record<string, number>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]));

function SheetEditor({ sessionId, onSaved }: { sessionId: number; onSaved: () => void }) {
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
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  const router = useRouter();

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

  if (!sheet || !template) return error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator />;

  return (
    <View style={styles.section}>
      <View style={styles.headRow}>
        <View style={styles.flex}>
          <Text style={styles.h2}>{template.name}</Text>
          <Text style={styles.dim}>
            {sheet.exists ? `${filled} values` : 'No sheet for this run yet'}
            {sheet.previous ? ` · previous run with a sheet: ${sheet.previous.name ?? 'session ' + sheet.previous.session_id}` : ''}
          </Text>
        </View>
      </View>

      {!sheet.exists && templates.length > 1 && (
        <View style={styles.chipsWrap}>
          {templates.map((t) => (
            <Pressable
              key={t.key}
              onPress={() => setSheet({ ...sheet, template: t.key })}
              style={[styles.smallChip, t.key === template.key && { borderColor: tint }]}>
              <Text style={t.key === template.key ? { color: tint } : undefined}>{t.name}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.actions}>
        {sheet.previous && (
          <Pressable
            style={StyleSheet.flatten([styles.button, styles.outline, { borderColor: tint }])}
            onPress={copy}
            disabled={busy}>
            <Text style={[styles.buttonText, { color: tint }]}>
              {confirmCopy ? 'Tap again to replace this sheet' : `Copy from ${sheet.previous.name ?? 'previous run'}`}
            </Text>
          </Pressable>
        )}
        <Pressable style={[styles.button, { backgroundColor: tint }]} onPress={save} disabled={busy}>
          {busy ? <ActivityIndicator color={onTint(tint)} /> : <Text style={[styles.buttonText, { color: onTint(tint) }]}>Save</Text>}
        </Pressable>
      </View>
      {dirty && <Text style={styles.dim}>Unsaved changes</Text>}
      {message && !dirty && <Text style={{ color: tint }}>{message}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}

      {sheet.changes.length > 0 && !dirty && (
        <View style={styles.card}>
          <Text style={styles.subhead}>Changed from {sheet.previous?.name ?? 'the previous run'}</Text>
          {sheet.changes.map((c) => (
            <Text key={c.key}>{c.text}</Text>
          ))}
        </View>
      )}
      {sheet.warnings.length > 0 && !dirty && (
        <View style={styles.card}>
          {sheet.warnings.map((w) => (
            <Text key={w.key} style={{ color: WARN }}>
              {w.text}
            </Text>
          ))}
        </View>
      )}

      <View style={styles.linkRow}>
        <Pressable onPress={() => setShowSources((s) => !s)} hitSlop={6}>
          <Text style={{ color: tint }}>{showSources ? 'Hide' : 'Show'} where each item comes from</Text>
        </Pressable>
        {sheet.exists && template.vehicle_preset && (
          <Pressable
            onPress={() => router.push({ pathname: '/tools/vehicle', params: { session: sessionId } })}
            hitSlop={6}>
            <Text style={{ color: tint }}>Open in the vehicle model</Text>
          </Pressable>
        )}
      </View>

      {template.groups.map((g) => (
        <View key={g.name} style={styles.group}>
          <Text style={styles.groupName}>{g.name}</Text>
          {g.rows.map((row) => (
            <RowEditor
              key={row.key}
              row={row}
              form={form}
              prev={filled > 0 ? prev : null}
              showSources={showSources}
              setField={setField}
              text={text}
              tint={tint}
            />
          ))}
        </View>
      ))}

      <View style={styles.group}>
        <Text style={styles.groupName}>Notes</Text>
        <TextInput
          style={[styles.input, styles.notes, { color: text }]}
          value={notes}
          onChangeText={(t) => {
            setNotes(t);
            setDirty(true);
          }}
          placeholder="Anything else about this run's setup"
          placeholderTextColor="#8888"
          multiline
        />
      </View>
      <Pressable style={[styles.button, { backgroundColor: tint }]} onPress={save} disabled={busy}>
        <Text style={[styles.buttonText, { color: onTint(tint) }]}>Save</Text>
      </Pressable>
    </View>
  );
}

// White text on the light theme's blue, black text on the dark theme's white tint.
const onTint = (tint: string) => (tint.toLowerCase() === '#fff' || tint.toLowerCase() === '#ffffff' ? '#000' : '#fff');

function RowEditor({
  row,
  form,
  prev,
  showSources,
  setField,
  text,
  tint,
}: {
  row: TemplateRow;
  form: Record<string, string>;
  prev: Record<string, number> | null;
  showSources: boolean;
  setField: (key: string, value: string) => void;
  text: string;
  tint: string;
}) {
  const cells = row.layout === 'corner' ? [row.fields.slice(0, 2), row.fields.slice(2)] : [row.fields];
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <Text style={styles.rowLabel}>{row.label}</Text>
        <Text style={styles.unit}>
          {row.unit && row.kind !== 'choice' ? row.unit : ''}
          {row.confidence !== 'published' ? `${row.unit && row.kind !== 'choice' ? ' · ' : ''}${row.confidence}` : ''}
        </Text>
      </View>
      {cells.map((line, i) => (
        <View key={i} style={styles.cells}>
          {line.map((f) => {
            const value = form[f.key] ?? '';
            const before = prev?.[f.key];
            const now = value.trim() === '' ? null : Number(value.replace(',', '.'));
            const changed = prev != null && (before ?? null) !== now;
            return (
              <View key={f.key} style={[styles.cell, row.kind === 'choice' && styles.wideCell]}>
                {f.at && <Text style={styles.at}>{POSITION_LABEL[f.at]}</Text>}
                <FieldInput row={row} value={value} onChange={(v) => setField(f.key, v)} text={text} tint={tint} />
                {changed && (
                  <Text style={[styles.was, { color: tint }]}>was {showValue(row, before)}</Text>
                )}
              </View>
            );
          })}
        </View>
      ))}
      {showSources && row.note ? <Text style={styles.note}>{row.note}</Text> : null}
    </View>
  );
}

function FieldInput({
  row,
  value,
  onChange,
  text,
  tint,
}: {
  row: TemplateRow;
  value: string;
  onChange: (v: string) => void;
  text: string;
  tint: string;
}) {
  if (row.kind === 'choice') {
    return (
      <View style={styles.options}>
        {row.options.map((o) => {
          const on = value === String(o.value);
          return (
            <Pressable
              key={o.value}
              onPress={() => onChange(on ? '' : String(o.value))}
              style={[styles.option, on && { borderColor: tint }]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}>
              <Text style={on ? { color: tint, fontWeight: '600' } : undefined}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
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
    return (
      <View style={styles.stepper}>
        <Pressable onPress={() => step(-1)} hitSlop={8} accessibilityLabel={`${row.label} down`}>
          <Text style={[styles.step, { color: tint }]}>−</Text>
        </Pressable>
        <Text style={styles.stepValue}>
          {n == null ? '–' : n}
          {row.max != null ? <Text style={styles.unit}> /{row.max}</Text> : null}
        </Text>
        <Pressable onPress={() => step(1)} hitSlop={8} accessibilityLabel={`${row.label} up`}>
          <Text style={[styles.step, { color: tint }]}>+</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <TextInput
      style={[styles.input, { color: text }]}
      value={value}
      onChangeText={onChange}
      keyboardType="numbers-and-punctuation"
      selectTextOnFocus
      placeholder="–"
      placeholderTextColor="#8888"
    />
  );
}

// ---------- runs against results ----------

function RunsView({ sessionId, onPick }: { sessionId: number; onPick: (id: number) => void }) {
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

  if (error) return <Text style={styles.error}>{error}</Text>;
  if (!hist) return <ActivityIndicator />;
  const unit = hist.runs.find((r) => r.summary?.steer_unit)?.summary?.steer_unit ?? '';
  const channel = hist.runs.find((r) => r.summary?.steer_channel)?.summary?.steer_channel;
  return (
    <View style={styles.section}>
      <Text style={styles.dim}>
        Every run of this test in order. Each one is set against the last run before it with a sheet and clean laps:
        what changed on the car, and what the lap times and the balance did.
      </Text>
      {progress && (
        <View style={styles.progress}>
          <ActivityIndicator />
          <Text style={styles.dim}>
            Reading the balance from the logs: {progress.done + 1} of {progress.total}
          </Text>
        </View>
      )}
      {hist.runs.map((r) => (
        <RunCard key={r.session_id} run={r} current={r.session_id === sessionId} onPick={onPick} />
      ))}
      <Text style={styles.note}>
        Best and Top 3 (the mean of the three quickest clean laps), with the change from the run it is compared with:
        green is quicker. Balance is the steering used beyond what the corner needs ({unit || 'steering units'}
        {channel ? ` of ${channel}` : ''}), median while cornering on the clean laps, on entry (on the brakes), mid-corner
        and exit (on the throttle): + is more understeer, − more oversteer. Per g is how fast it grows with cornering
        g. It is calibrated on each run's own gentle cornering, so runs of the same car compare. TC and ABS: seconds
        working per clean lap.
      </Text>
    </View>
  );
}

function RunCard({ run, current, onPick }: { run: HistoryRun; current: boolean; onPick: (id: number) => void }) {
  const tint = useThemeColor({}, 'tint');
  const d = run.deltas;
  const b = run.summary?.balance;
  const lapColor = (x: number | null | undefined) =>
    x == null || Math.abs(x) < 0.005 ? undefined : x < 0 ? FASTER : SLOWER;
  return (
    <Pressable
      onPress={() => onPick(run.session_id)}
      style={[styles.card, current && { borderColor: tint, borderWidth: 2 }]}
      accessibilityRole="button">
      <View style={styles.headRow}>
        <Text style={[styles.runName, current && { color: tint }]}>{run.name ?? `Session ${run.session_id}`}</Text>
        <Text style={styles.dim}>{runDate(run.run_time)}</Text>
      </View>
      {run.has_setup ? (
        run.compared_with ? (
          run.changes.length ? (
            <View>
              <Text style={styles.dim}>Changed from {run.compared_with.name}:</Text>
              {run.changes.map((c) => (
                <Text key={c.key} style={styles.change}>
                  {c.text}
                </Text>
              ))}
            </View>
          ) : (
            <Text style={styles.dim}>Same setup as {run.compared_with.name}</Text>
          )
        ) : (
          <Text style={styles.dim}>First sheet of the test</Text>
        )
      ) : (
        <Text style={styles.dim}>No setup sheet</Text>
      )}
      {run.laps.clean_laps === 0 ? (
        <Text style={styles.dim}>No clean laps</Text>
      ) : (
        <View style={styles.stats}>
          {/* three groups that wrap as a whole: lap times, balance, driver aids */}
          <View style={styles.statGroup}>
            <Stat label="Best" value={formatLap(run.laps.best_s)} delta={signed(d?.best_s)} color={lapColor(d?.best_s)} />
            <Stat label="Top 3" value={formatLap(run.laps.top3_s)} delta={signed(d?.top3_s)} color={lapColor(d?.top3_s)} />
            <Stat label="Laps" value={String(run.laps.clean_laps)} />
          </View>
          {b ? (
            <View style={styles.statGroup}>
              <Stat label="Entry" value={fmt(b.entry)} delta={signed(d?.balance.entry)} />
              <Stat label="Mid" value={fmt(b.mid)} delta={signed(d?.balance.mid)} />
              <Stat label="Exit" value={fmt(b.exit)} delta={signed(d?.balance.exit)} />
              <Stat label="Per g" value={fmt(b.gradient_per_g)} delta={signed(d?.balance.gradient_per_g)} />
            </View>
          ) : run.needs_summary ? (
            <Stat label="Balance" value="…" />
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

const fmt = (x: number | null | undefined) => (x == null ? '–' : x.toFixed(2));

function Stat({ label, value, delta, color }: { label: string; value: string; delta?: string; color?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      {delta != null && delta !== '–' && <Text style={[styles.statDelta, color ? { color } : styles.dim]}>{delta}</Text>}
    </View>
  );
}

// ---------- suggestions ----------

function IdeasView({ sessionId }: { sessionId: number }) {
  const [data, setData] = useState<Suggestions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');

  useEffect(() => {
    let live = true;
    setupApi.suggestions(sessionId).then(
      (s) => live && setData(s),
      (e) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [sessionId]);

  if (error) return <Text style={styles.error}>{error}</Text>;
  if (!data) return <ActivityIndicator />;
  return (
    <View style={styles.section}>
      <Text style={styles.dim}>
        Setup changes to try, best first, from what the driver said about this run. Each one says why, what to expect
        and what to watch. Change one thing at a time.
      </Text>
      {data.notes.map((n) => (
        <Text key={n} style={styles.note}>
          {n}
        </Text>
      ))}
      {data.suggestions.length === 0 && data.observations.length > 0 && (
        <Text>Nothing in the feedback points clearly to a setup change.</Text>
      )}
      {data.suggestions.map((s) => (
        <View key={s.lever} style={styles.card}>
          <View style={styles.headRow}>
            <Text style={[styles.rank, { color: tint }]}>{s.rank}</Text>
            <Text style={[styles.runName, styles.flex]}>{s.title}</Text>
            <Text style={styles.source}>{s.sources.map((x) => (x === 'data' ? 'logger' : 'driver')).join(' + ')}</Text>
          </View>
          {s.changes.map((c) => (
            <Text key={c.key} style={styles.change}>
              {c.text}
            </Text>
          ))}
          <Text>
            <Text style={styles.bold}>Why: </Text>
            {s.reason}
          </Text>
          <Text>
            <Text style={styles.bold}>Expect: </Text>
            {s.expected}
            {s.model ? ` ${s.model}` : ''}
          </Text>
          {s.watch ? (
            <Text>
              <Text style={styles.bold}>Watch: </Text>
              {s.watch}
            </Text>
          ) : null}
        </View>
      ))}
      {data.observations.length > 0 && (
        <View style={styles.group}>
          <Text style={styles.groupName}>Feedback used</Text>
          {data.observations.map((o, i) => (
            <View key={i} style={styles.obs}>
              <Text style={styles.bold}>
                {o.label}
                {o.speed && o.corner ? ` (${o.speed} corner)` : ''}
              </Text>
              <Text style={styles.dim}>
                {o.source === 'data' ? 'Logger' : 'Driver'}: “{o.text}”
              </Text>
            </View>
          ))}
          {data.skipped_points.length > 0 && (
            <Text style={styles.note}>
              {data.skipped_points.length} other debrief point{data.skipped_points.length > 1 ? 's' : ''} had nothing
              for the setup.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12, paddingBottom: 48, width: '100%', maxWidth: 860, alignSelf: 'center' },
  intro: { opacity: 0.75 },
  chips: { gap: 8 },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  chipSub: { fontSize: 12, opacity: 0.6, fontVariant: ['tabular-nums'] },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  smallChip: { borderWidth: 1, borderColor: '#8884', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  tabs: { flexDirection: 'row', gap: 8 },
  tab: { flex: 1, borderWidth: 1, borderColor: '#8884', borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  tabText: { fontWeight: '600' },
  section: { gap: 10 },
  headRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, backgroundColor: 'transparent' },
  flex: { flex: 1, backgroundColor: 'transparent' },
  h2: { fontSize: 18, fontWeight: '700' },
  dim: { opacity: 0.65 },
  error: { color: '#c8372d' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { borderRadius: 8, paddingVertical: 12, paddingHorizontal: 18, alignItems: 'center', flexGrow: 1 },
  outline: { borderWidth: 1, backgroundColor: 'transparent' },
  buttonText: { fontWeight: '600', fontSize: 16 },
  card: { gap: 6, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#8883' },
  subhead: { fontWeight: '600' },
  linkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  group: { gap: 2 },
  groupName: {
    fontSize: 13,
    fontWeight: '600',
    opacity: 0.6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
  },
  row: { paddingVertical: 8, borderBottomWidth: 1, borderColor: '#8882', gap: 6 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  rowLabel: { fontSize: 16, fontWeight: '500' },
  unit: { fontSize: 12, opacity: 0.6 },
  cells: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  cell: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 150, flexGrow: 1, flexBasis: 150 },
  wideCell: { minWidth: 250, flexBasis: 250 }, // three option chips and the axle label
  at: { width: 34, fontSize: 13, opacity: 0.6 },
  was: { fontSize: 12 },
  note: { fontSize: 12, opacity: 0.7, lineHeight: 17 },
  input: {
    borderWidth: 1,
    borderColor: '#8884',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    width: 76,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  notes: { width: '100%', minHeight: 64, textAlign: 'left', textAlignVertical: 'top' },
  options: { flexDirection: 'row', gap: 6 },
  option: { borderWidth: 1, borderColor: '#8884', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  step: { fontSize: 24, fontWeight: '600', paddingHorizontal: 6 },
  stepValue: { fontVariant: ['tabular-nums'], minWidth: 36, textAlign: 'center', fontSize: 16 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  runName: { fontSize: 16, fontWeight: '600' },
  change: { fontWeight: '600' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 28, rowGap: 8, backgroundColor: 'transparent' },
  statGroup: { flexDirection: 'row', columnGap: 16, backgroundColor: 'transparent' },
  stat: { minWidth: 56, backgroundColor: 'transparent' },
  statLabel: { fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.4 },
  statValue: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  statDelta: { fontSize: 12, fontVariant: ['tabular-nums'] },
  rank: { fontSize: 20, fontWeight: '700', width: 22 },
  source: { fontSize: 12, opacity: 0.6 },
  bold: { fontWeight: '600' },
  obs: { paddingVertical: 4, gap: 1 },
});
