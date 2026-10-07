import { Link, Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { ErrorLine, FormActions, MainButton } from '@/components/Controls';
import { Choice, DriverChoice, toPick } from '@/components/DriverPicker';
import { Notice, PageHead, useText } from '@/components/Picks';
import PrintButton from '@/components/PrintButton';
import { Colophon, Label, Page, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { Driver, driversApi } from '@/lib/drivers';
import { DriverPrint, FingerprintDb, fingerprintsApi, LapLink, Trait } from '@/lib/fingerprints';
import { themed, useTheme } from '@/constants/Theme';

const POLL_MS = 5000;

// The driver fingerprint database: how each driver drives, learned from the runs tagged with their name and set
// against their teammates in the same car, which habits go with quicker laps in all the data, and the styles still
// waiting for a name. The server keeps it worked out after every upload, so the page only reads it.
export default function FingerprintsScreen() {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const [db, setDb] = useState<FingerprintDb | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true); // false once the page is gone: an answer still on its way is dropped, not polled on

  const load = useCallback(() => {
    fingerprintsApi.all().then(
      (d) => {
        if (!live.current) return;
        setDb(d);
        setError(null);
        if (timer.current) clearTimeout(timer.current);
        if (d.updating) timer.current = setTimeout(load, POLL_MS); // the latest uploads are still being added
      },
      (e) => live.current && setError((e as Error).message),
    );
  }, []);
  const loadDrivers = useCallback(() => {
    driversApi.list().then((d) => live.current && setDrivers(d), () => live.current && setDrivers([]));
  }, []);
  useEffect(() => {
    live.current = true;
    load();
    loadDrivers();
    return () => {
      live.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, loadDrivers]);
  const named = useCallback(() => {
    load();
    loadDrivers(); // a new driver may have been added
  }, [load, loadDrivers]);

  let no = 0;
  const next = () => ++no;
  const pace = db?.links.filter((l) => !l.outcome) ?? [];
  const outcome = db?.links.filter((l) => l.outcome) ?? [];

  return (
    <Page>
      <Stack.Screen options={{ title: 'Driver fingerprints' }} />
      <PageHead title="Driver fingerprints"
        dek="How each driver drives, from braking to throttle to steering, learned from the runs tagged with their name and set against their teammates in the same car. Every upload adds to it.">
        <PrintButton title="Driver fingerprints" />
      </PageHead>

      {db == null && !error && <ActivityIndicator color={theme.text} style={styles.gap} />}
      {error && <Text style={StyleSheet.flatten([t.error, styles.gap])}>{error}</Text>}
      {db?.updating && (
        <Notice busy style={styles.gap}><Text style={t.note}>Adding the latest uploads to the fingerprints…</Text></Notice>
      )}

      {db != null && db.drivers.length === 0 && (
        <View style={StyleSheet.flatten([styles.block, styles.gap])}>
          <Text style={t.body}>
            No fingerprints yet. After an upload the app asks once who each driver it can't name is, and learns
            their style from the answer. From then on it sets the driver of every run by itself, at every event, and
            shows it as set from the driving style so you can change it.
          </Text>
          <TextLink href="/drivers/tag" label="Tag drivers" arrow />
        </View>
      )}

      {db?.drivers.map((d) => <DriverSection key={d.driver_id} no={next()} d={d} drivers={drivers} onNamed={named} />)}

      {db != null && db.links.length > 0 && (
        <Section no={next()} title="What goes with quicker laps"
          dek="Every lap against the typical lap of its own run, all drivers and events together, so track, tyres and fuel are taken out.">
          <View style={styles.block}>
            {pace.map((l) => <LinkRow key={l.kind} l={l} />)}
            {outcome.length > 0 && (
              <View style={styles.list}>
                <Text style={t.sub}>Results of pace, not advice</Text>
                <Text style={t.note}>
                  These follow from going quicker rather than make the car quicker: a quicker lap spends less time
                  braking and more at full throttle anyway.
                </Text>
                {outcome.map((l) => <LinkRow key={l.kind} l={l} />)}
              </View>
            )}
            <Text style={t.small}>
              Link: how closely the habit follows lap time, from 0 (not at all) to 1 (always). From {db.links[0].laps} laps.
            </Text>
          </View>
        </Section>
      )}

      {db != null && db.unnamed.length > 0 && (
        <Section no={next()} title="Drivers waiting for a name"
          dek="Drivers the app tells apart by their style at these events but can't name yet. Name one once, and every run in that style gets the name and teaches their fingerprint.">
          <View style={styles.list}>
            {db.unnamed.map((u) => (
              <View key={`${u.event_id}-${u.label}`} style={styles.row}>
                <Link href={{ pathname: '/event/[id]', params: { id: String(u.event_id) } }} asChild>
                  <Pressable accessibilityRole="link" hitSlop={4} style={styles.flex}>
                    <Text style={t.body}><Text style={t.strong}>{u.label}</Text> at {u.event ?? `Event ${u.event_id}`}</Text>
                  </Pressable>
                </Link>
                <Text style={t.num}>{u.laps} laps</Text>
                <NameStyle ids={u.session_ids} label="This is…" drivers={drivers} onNamed={named} />
              </View>
            ))}
          </View>
        </Section>
      )}

      {db != null && db.kinds.length > 0 && (
        <Section no={next()} title="What is measured"
          dek="Each corner of every clean lap, averaged over the lap. A driver's fingerprint is how they differ from their teammates in the same car.">
          <View style={styles.list}>
            {db.kinds.map((k) => (
              <View key={k.kind} style={styles.glossary}>
                <Label small>{k.label}</Label>
                <Text style={t.note}>{k.explain}</Text>
              </View>
            ))}
          </View>
        </Section>
      )}

      <Colophon left="The Engineer · Driver fingerprints"
        right={db ? `${db.drivers.length} drivers · ${db.events} events` : undefined} />
    </Page>
  );
}

/** One driver: their style in words, what it means for lap time, the events it was learned from with the pace
 * against teammates, and where the fingerprint found them without a tag. */
function DriverSection({ no, d, drivers, onNamed }: { no: number; d: DriverPrint; drivers: Driver[]; onNamed: () => void }) {
  const styles = useStyles();
  const t = useText();
  const wide = useWide();
  const events = d.events.length;
  return (
    <Section no={no} title={d.driver}
      dek={`${d.laps} laps over ${events} event${events === 1 ? '' : 's'}, against teammates in the same car.`}>
      <View style={styles.block}>
        <View style={styles.list}>
          <Text style={t.sub}>Driving style</Text>
          {d.traits.length === 0 ? (
            <Text style={t.note}>Drives much like their teammates: nothing stands out yet.</Text>
          ) : d.traits.map((tr) => <TraitRow key={tr.kind} tr={tr} />)}
        </View>

        {d.advice.length > 0 && (
          <View style={styles.list}>
            <Text style={t.sub}>For lap time</Text>
            {d.advice.map((a) => (
              <View key={a.kind} style={styles.advice}>
                <Label small style={a.type === 'gain' ? styles.gain : undefined}>
                  {a.type === 'gain' ? 'Room to gain' : 'A strength'} · {a.label}
                </Label>
                <Text style={t.body}>{a.words}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={styles.list}>
          <Text style={t.sub}>Learned at</Text>
          {d.events.map((e) => (
            <View key={e.event_id} style={wide ? styles.row : styles.rowPhone}>
              <EventName id={e.event_id} name={e.event} date={e.date} />
              <View style={styles.figs}>
                <Text style={t.num}>{e.laps} laps</Text>
                {e.best_s != null && <Text style={t.num}>best {formatLap(e.best_s)}</Text>}
                {e.gap_to_teammates_s != null && (
                  <Text style={t.num}>
                    {e.gap_to_teammates_s >= 0 ? '+' : '−'}{Math.abs(e.gap_to_teammates_s).toFixed(3)} s to {e.teammates.join(', ')}
                  </Text>
                )}
              </View>
              <NameStyle ids={e.session_ids} label="Not them?" drivers={drivers} onNamed={onNamed} />
            </View>
          ))}
          <Text style={t.small}>The gap compares the average of each side's three quickest laps.</Text>
        </View>

        {d.also_found.length > 0 && (
          <View style={styles.list}>
            <Text style={t.sub}>Found by style, not tagged</Text>
            {d.also_found.map((f) => (
              <View key={f.event_id} style={wide ? styles.row : styles.rowPhone}>
                <EventName id={f.event_id} name={f.event} />
                <View style={styles.figs}>
                  <Text style={t.num}>{f.laps} laps</Text>
                  <Text style={t.num}>match {Math.round(f.match * 100)} %</Text>
                </View>
                <NameStyle ids={f.session_ids} label="Not them?" drivers={drivers} onNamed={onNamed} />
              </View>
            ))}
            <Text style={t.small}>Confirm these on the event page to teach the fingerprint more.</Text>
          </View>
        )}
      </View>
    </Section>
  );
}

/** "This is…": who drives one of an event's driving styles, picked from the garage or a new name. Every run in
 * that style gets the driver, as a person's tag that teaches their fingerprint, so a style is named, a wrong one is
 * put right, or two names for one driver become one. */
function NameStyle({ ids, label, drivers, onNamed }: {
  ids: number[] | undefined;
  label: string;
  drivers: Driver[];
  onNamed: () => void;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ids?.length) return null; // an older server
  if (!open) return <TextLink small label={label} onPress={() => setOpen(true)} />;
  const ready = choice != null && ('id' in choice || choice.name.trim() !== '');
  const save = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await driversApi.assign(toPick(choice), ids);
      setOpen(false);
      setChoice(undefined);
      onNamed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.name}>
      <Label small>{`This is… (${ids.length} run${ids.length === 1 ? '' : 's'})`}</Label>
      <DriverChoice drivers={drivers} value={choice} onChange={setChoice} allowNone={false} />
      <FormActions>
        <MainButton label="Name them" onPress={save} busy={busy} disabled={!ready} />
        <TextLink label="Cancel" onPress={() => setOpen(false)} disabled={busy} />
      </FormActions>
      {error && <ErrorLine>{error}</ErrorLine>}
    </View>
  );
}

function TraitRow({ tr }: { tr: Trait }) {
  const styles = useStyles();
  const t = useText();
  const size = Math.abs(tr.value);
  return (
    <View style={styles.trait}>
      <View style={styles.traitHead}>
        <Label small>{tr.label}</Label>
        <Label small muted>{size >= 1 ? 'Marked' : size >= 0.6 ? 'Clear' : 'Slight'}</Label>
      </View>
      <Text style={t.body}>{cap(tr.words)}.</Text>
      <Text style={t.small}>{tr.explain}</Text>
    </View>
  );
}

function LinkRow({ l }: { l: LapLink }) {
  const styles = useStyles();
  const t = useText();
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Label small>{l.label}</Label>
        <Text style={t.body}>{l.words}.</Text>
      </View>
      <Text style={t.num}>link {Math.abs(l.r).toFixed(2)}</Text>
    </View>
  );
}

function EventName({ id, name, date }: { id: number; name: string | null; date?: string | null }) {
  const styles = useStyles();
  const t = useText();
  return (
    <Link href={{ pathname: '/event/[id]', params: { id: String(id) } }} asChild>
      <Pressable accessibilityRole="link" hitSlop={4} style={styles.flex}>
        <Text style={t.body}>
          <Text style={t.strong}>{name ?? `Event ${id}`}</Text>{date ? `  ${date}` : ''}
        </Text>
      </Pressable>
    </Link>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const useStyles = themed((c) => ({
  gap: { marginTop: 24 },
  block: { gap: 26 },
  list: { gap: 12 },
  flex: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' },
  rowPhone: { gap: 4 },
  figs: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 2 },
  trait: { gap: 3, borderLeftWidth: 3, borderColor: c.rule, paddingLeft: 12 },
  traitHead: { flexDirection: 'row', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' },
  advice: { gap: 3 },
  gain: { color: c.mark },
  glossary: { gap: 2, maxWidth: 720 },
  name: { width: '100%', gap: 12, borderLeftWidth: 3, borderColor: c.mark, paddingLeft: 12, marginTop: 4 },
}));
