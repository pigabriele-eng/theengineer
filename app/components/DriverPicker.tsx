// Who drove: pick one of the drivers, type a new name, or nobody. Used on the tagging screen (the session page and the
// event page's run rows use the words in RunChips.tsx). The drivers as words in Archivo capitals, the picked one
// underlined in red; a new name on an ink rule.
import { Choice as Word, Choices, Field, Input } from '@/components/Controls';
import { TextLink } from '@/components/Programme';
import { View } from '@/components/Themed';
import { Driver, DriverPick } from '@/lib/drivers';
import { themed } from '@/constants/Theme';

// The choice being made: a driver's id, a new name, or null for "no driver".
export type Choice = { id: number } | { name: string } | null;

export const toPick = (c: Choice): DriverPick =>
  c == null ? { driver_id: null } : 'id' in c ? { driver_id: c.id } : { driver_name: c.name.trim() };

export function DriverChoice({ drivers, value, onChange, allowNone = true }: {
  drivers: Driver[];
  value: Choice | undefined;
  onChange: (c: Choice | undefined) => void;
  allowNone?: boolean;
}) {
  const styles = useStyles();
  const typed = value != null && 'name' in value ? value.name : '';
  return (
    <View style={styles.choice}>
      {drivers.length > 0 || allowNone ? (
        <Choices>
          {drivers.map((d) => (
            <Word key={d.id} label={d.name} on={value != null && 'id' in value && value.id === d.id}
              onPress={() => onChange({ id: d.id })} />
          ))}
          {allowNone && <Word label="No driver" on={value === null} onPress={() => onChange(null)} />}
        </Choices>
      ) : null}
      <Field label={drivers.length ? 'Or a new driver' : 'Driver'} style={styles.field}>
        <Input value={typed} onChangeText={(name) => onChange(name ? { name } : undefined)} placeholder="Name"
          maxLength={120} accessibilityLabel="New driver's name" />
      </Field>
      <TextLink href="/garage" label="Cars, drivers and teams" arrow small />
    </View>
  );
}

// The Sessions tab's way in: tag sessions with their drivers, and compare two drivers over many laps.
export function DriverLinks() {
  const styles = useStyles();
  return (
    <View style={styles.links}>
      <TextLink href="/drivers/tag" label="Tag drivers" arrow />
      <TextLink href="/drivers/compare" label="Compare drivers" arrow />
    </View>
  );
}

const useStyles = themed(() => ({
  choice: { gap: 16, alignItems: 'flex-start' },
  field: { alignSelf: 'stretch', maxWidth: 420 },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 10 },
}));
