// An event's name and its first and last day: to make an event (Sessions page, before an upload) or change one.
import { ReactNode, useState } from 'react';
import { StyleSheet } from 'react-native';

import { ErrorLine, Field, FormActions, Input, MainButton, Note } from '@/components/Controls';
import { TextLink } from '@/components/Programme';
import { View } from '@/components/Themed';
import { parseDay, typedDay } from '@/lib/events';

export type EventFormValue = { name: string; start: string | null; end: string | null };

export function EventForm({ initial, submitLabel, onSubmit, onCancel, datesHint, extra }: {
  initial?: Partial<EventFormValue>;
  submitLabel: string;
  onSubmit: (v: EventFormValue) => Promise<unknown>;
  onCancel?: () => void;
  datesHint?: string;
  extra?: ReactNode; // more fields, under the name (a planned event's venue)
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [start, setStart] = useState(typedDay(initial?.start ?? null));
  const [end, setEnd] = useState(typedDay(initial?.end ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const s = start.trim() ? parseDay(start) : null;
    const e = end.trim() ? parseDay(end) : null;
    if (!name.trim()) return setError('Give the event a name.');
    if (start.trim() && !s) return setError('The first day isn’t a date: type it as dd/mm/yyyy.');
    if (end.trim() && !e) return setError('The last day isn’t a date: type it as dd/mm/yyyy.');
    if (s && e && e < s) return setError('The last day is before the first day.');
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), start: s ?? e, end: e ?? s });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.form}>
      <Field label="Name">
        <Input value={name} onChangeText={setName} placeholder="e.g. GT4 Germany Hockenheim" maxLength={160}
          accessibilityLabel="Event name" />
      </Field>
      {extra}
      <View style={styles.dates}>
        <Field label="First day" style={styles.date}>
          <Input value={start} onChangeText={setStart} placeholder="dd/mm/yyyy" maxLength={10} inputMode="numeric"
            accessibilityLabel="First day" />
        </Field>
        <Field label="Last day" style={styles.date}>
          <Input value={end} onChangeText={setEnd} placeholder="dd/mm/yyyy" maxLength={10} inputMode="numeric"
            accessibilityLabel="Last day" />
        </Field>
      </View>
      <Note>{datesHint ?? 'Leave the dates empty to take them from the logs.'}</Note>
      {error && <ErrorLine>{error}</ErrorLine>}
      <FormActions>
        <MainButton label={submitLabel} onPress={submit} busy={busy} />
        {onCancel && <TextLink onPress={onCancel} label="Cancel" />}
      </FormActions>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 14 },
  dates: { flexDirection: 'row', gap: 20 },
  date: { flex: 1, minWidth: 0 },
});
