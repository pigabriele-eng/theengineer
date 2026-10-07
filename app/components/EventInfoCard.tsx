// The event page's "Event info" section: what the event was run with (tyre, car, team, drivers 1 to 4), each from the
// event itself or from its season, and what is still missing. Tap a missing item (or Edit) for the form.
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

import { EventInfoForm, MissingList, useLists } from '@/components/EventInfoForm';
import { Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { EventInfo, MissingKey, seasonsApi, sourceWords } from '@/lib/seasons';
import { Fonts, themed, Type } from '@/constants/Theme';

export function EventInfoCard({ no, eventId, version, onInfo }: {
  no: number; // its section number on the page
  eventId: number;
  version?: unknown; // the event changed (runs uploaded or tagged): ask again
  onInfo?: (info: EventInfo | null) => void;
}) {
  const styles = useStyles();
  const wide = useWide();
  const [info, setInfo] = useState<EventInfo | null>(null);
  const [editing, setEditing] = useState<{ focus: MissingKey | null } | null>(null);
  const { lists, reload } = useLists();

  useEffect(() => {
    seasonsApi.info(eventId).then(
      (i) => {
        setInfo(i);
        onInfo?.(i);
      },
      () => onInfo?.(null), // an older server: no section
    );
  }, [eventId, version]); // eslint-disable-line react-hooks/exhaustive-deps -- onInfo is a callback of the page

  const season = info?.season;
  const dek = season
    ? `What it was run with; what isn’t set on the event comes from ${season.name}.`
    : 'What it was run with: the tyre, the car, the team and drivers 1 to 4.';
  if (!info) return <Section no={no} title="Event info" dek={dek} />;
  const r = info.resolved;
  const car = r.car ? [r.car.number ? `#${r.car.number}` : r.car.name, r.vehicle_model?.name ?? r.car.model]
    .filter(Boolean).join(' · ') : r.vehicle_model?.name ?? null;
  const items: { label: string; value: string | null; from: string | null }[] = [
    { label: 'Tyre', value: r.tyre_kind?.label ?? null, from: sourceWords(info.from.tyre_kind) },
    { label: 'Car', value: car, from: sourceWords(info.from.car ?? info.from.vehicle_model) },
    { label: 'Team', value: r.team?.name ?? null, from: sourceWords(info.from.team) },
    { label: r.drivers.length === 1 ? 'Driver' : 'Drivers',
      value: r.drivers.length ? r.drivers.map((d, i) => `${i + 1} ${d.name}`).join('  ') : null,
      from: sourceWords(info.from.drivers) },
  ];
  return (
    <Section no={no} title="Event info" dek={dek}>
      <View style={styles.links}>
        {!editing && <TextLink onPress={() => setEditing({ focus: null })} label="Edit" small />}
        {season && (
          <TextLink href="/seasons" small arrow
            label={`${season.name}${season.round ? ` · round ${season.round.order}` : ''}`} />
        )}
      </View>
      {editing && lists ? (
        <View style={styles.form}>
          <EventInfoForm info={info} lists={lists} onListsChanged={reload} focus={editing.focus}
            onCancel={() => setEditing(null)}
            onSaved={(saved) => {
              setInfo(saved);
              onInfo?.(saved);
              setEditing(null);
            }} />
        </View>
      ) : (
        <>
          <View style={wide ? styles.strip : styles.lines}>
            {items.map((it, i) => (
              <View key={it.label} style={StyleSheet.flatten([wide ? styles.cell : styles.line,
                wide && i === 0 && styles.cellFirst, wide && i === items.length - 1 && styles.cellLast])}>
                <Text style={styles.label}>{it.label}</Text>
                <View style={wide ? undefined : styles.lineValue}>
                  <Text style={StyleSheet.flatten([styles.value, !wide && styles.valueRight, !it.value && styles.unset])}>
                    {it.value ?? 'not set'}
                  </Text>
                  {it.value && it.from ? (
                    <Text style={StyleSheet.flatten([styles.from, !wide && styles.valueRight])}>{it.from}</Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
          <MissingList missing={info.missing} onPick={(k) => setEditing({ focus: k })} />
        </>
      )}
    </Section>
  );
}

const useStyles = themed((c) => ({
  links: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 10, marginBottom: 16 },
  form: { maxWidth: 900 },
  // wide: the four in a strip split by ink rules
  strip: { flexDirection: 'row', borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.rule },
  cell: { flex: 1, minWidth: 0, paddingVertical: 12, paddingHorizontal: 16, borderRightWidth: 1, borderColor: c.rule, gap: 6 },
  cellFirst: { paddingLeft: 0 },
  cellLast: { borderRightWidth: 0 },
  // a phone: one line each, the label on the left and the value on the right
  lines: { borderTopWidth: 1, borderColor: c.rule },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 14, borderBottomWidth: 1,
    borderColor: c.separator, paddingTop: 9, paddingBottom: 8 },
  lineValue: { flex: 1, minWidth: 0 },
  label: { ...Type.label, fontFamily: Fonts.label, color: c.text },
  value: { fontFamily: Type.label.fontFamily, fontSize: 17, lineHeight: 22, color: c.text },
  valueRight: { textAlign: 'right' },
  unset: { fontFamily: Type.dek.fontFamily, color: c.textMuted },
  from: { fontFamily: Type.dek.fontFamily, fontSize: 14, lineHeight: 19, color: c.textSecondary },
}));
