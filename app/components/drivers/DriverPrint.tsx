// One driver's fingerprint (lib/fingerprints.ts) as a numbered section: their style in words, what it means for lap
// time, the events it was learned from and where the fingerprint found them without a tag, with "This is…" / "Not
// them?" to name or correct a driving style. Shown on the fingerprints page and, with only the clearest traits and
// lap time notes and the habit tracker under it (`children`), on the Drivers page.
import { Link } from 'expo-router';
import { ReactNode, useState } from 'react';
import { Pressable } from 'react-native';

import { ErrorLine, FormActions, MainButton } from '@/components/Controls';
import { Choice, DriverChoice, toPick } from '@/components/DriverPicker';
import { useText } from '@/components/Picks';
import { Label, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { Driver, driversApi } from '@/lib/drivers';
import { DriverPrint, Trait } from '@/lib/fingerprints';
import { themed } from '@/constants/Theme';

/** One driver: their style in words, what it means for lap time, the events it was learned from with the pace
 * against teammates, and where the fingerprint found them without a tag. */
export function DriverSection({ no, d, drivers, onNamed, summary, children }: { no: number; d: DriverPrint;
  drivers: Driver[]; onNamed: () => void; summary?: number; children?: ReactNode }) {
  const styles = useStyles();
  const t = useText();
  const wide = useWide();
  const events = d.events.length;
  // `summary`: only the clearest few traits and lap time notes, the rest on the fingerprints page
  const clearest = <T,>(xs: T[], by: (x: T) => number) =>
    summary == null ? xs : [...xs].sort((a, b) => Math.abs(by(b)) - Math.abs(by(a))).slice(0, summary);
  const shown = clearest(d.traits, (tr) => tr.value);
  const advice = clearest(d.advice, (a) => a.r);
  const cut = shown.length < d.traits.length || advice.length < d.advice.length;
  return (
    <Section no={no} title={d.driver}
      dek={`${d.laps} laps over ${events} event${events === 1 ? '' : 's'}, against teammates in the same car.`}>
      <View style={styles.block}>
        <View style={styles.list}>
          <Text style={t.sub}>Driving style</Text>
          {d.traits.length === 0 ? (
            <Text style={t.note}>Drives much like their teammates: nothing stands out yet.</Text>
          ) : shown.map((tr) => <TraitRow key={tr.kind} tr={tr} />)}
        </View>

        {advice.length > 0 && (
          <View style={styles.list}>
            <Text style={t.sub}>For lap time</Text>
            {advice.map((a) => (
              <View key={a.kind} style={styles.advice}>
                <Label small style={a.type === 'gain' ? styles.gain : undefined}>
                  {a.type === 'gain' ? 'Room to gain' : 'A strength'} · {a.label}
                </Label>
                <Text style={t.body}>{a.words}</Text>
              </View>
            ))}
          </View>
        )}
        {cut && (
          <TextLink href="/drivers/fingerprints" small arrow
            label={`All ${d.traits.length} traits and ${d.advice.length} lap time notes on the fingerprints page`} />
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
        {children}
      </View>
    </Section>
  );
}

/** "This is…": who drives one of an event's driving styles, picked from the garage or a new name. Every run in
 * that style gets the driver, as a person's tag that teaches their fingerprint, so a style is named, a wrong one is
 * put right, or two names for one driver become one. */
export function NameStyle({ ids, label, drivers, onNamed }: {
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
  name: { width: '100%', gap: 12, borderLeftWidth: 3, borderColor: c.mark, paddingLeft: 12, marginTop: 4 },
}));
