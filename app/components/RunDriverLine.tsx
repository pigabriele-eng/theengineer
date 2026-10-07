// A run's driver on one short line, for the run rows of the events open on the home page: who drove it, else who the
// driving style says drove it (marked "by style", with Confirm to take it in one tap), and Change (Set when nobody is
// named) to open the run's driver list in place: RunPicker in components/RunChips.tsx, the event page's own list.
// A style no driver is named for yet is never shown by a placeholder ("Style A"): the run simply has no driver.
import { TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { RunGuess } from '@/lib/fingerprints';
import { Garage, RunFields } from '@/lib/garage';
import { DriverRun, driverState, driverWords } from '@/lib/runDriver';
import { face, themed } from '@/constants/Theme';

/** The line itself, under the run's name: the driver, then Confirm (a style's guess) and Change. */
export function RunDriverLine({ run, guess, garage, open, onOpen, onPick }: {
  run: DriverRun;
  guess: RunGuess | undefined;
  garage: Garage | null;
  open: boolean; // its driver list is open under the row
  onOpen: (open: boolean) => void;
  onPick: (fields: RunFields) => void;
}) {
  const styles = useStyles();
  const st = driverState(run, guess, garage);
  const label = st.kind === 'none' ? `${run.name}: no driver`
    : st.kind === 'set' ? `${run.name}: driven by ${st.name}`
    : st.kind === 'auto' ? `${run.name}: driven by ${st.name}, set from the driving style`
    : `${run.name}: ${st.sure ? '' : 'probably '}driven by ${st.name}, going by the driving style`;
  return (
    <View style={styles.line}>
      <Text style={st.kind === 'set' || st.kind === 'auto' ? styles.name : styles.guess} numberOfLines={1}
        accessibilityLabel={label}>
        {driverWords(st)}
        {(st.kind === 'auto' || st.kind === 'guess') && <Text style={styles.how}> · by style</Text>}
      </Text>
      <View style={styles.acts}>
        {st.kind === 'guess' && st.confirm != null && (
          <TextLink label="Confirm" small onPress={() => onPick({ driver_id: st.confirm })} />
        )}
        <TextLink label={st.kind === 'none' ? 'Set' : 'Change'} small red={open} disabled={!garage}
          onPress={() => onOpen(!open)} />
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 12, rowGap: 4, marginTop: 5,
    backgroundColor: 'transparent' },
  name: { flexShrink: 1, maxWidth: '100%', fontFamily: face('label', 600), fontSize: 14, letterSpacing: 0.3,
    color: c.text },
  guess: { flexShrink: 1, maxWidth: '100%', fontFamily: face('body', 400, true), fontSize: 14, lineHeight: 19,
    color: c.textMuted },
  how: { fontFamily: face('body', 400, true), fontSize: 13, color: c.textMuted },
  acts: { flexDirection: 'row', alignItems: 'baseline', columnGap: 12, backgroundColor: 'transparent' },
}));
