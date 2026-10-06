// An event's name and its first and last day: to make an event (Sessions tab, before an upload) or change one.
import { ReactNode, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { parseDay, typedDay } from '@/lib/events';
import { Radius, themed, useTheme } from '@/constants/Theme';

export type EventFormValue = { name: string; start: string | null; end: string | null };

export function EventForm({ initial, submitLabel, onSubmit, onCancel, datesHint, extra }: {
  initial?: Partial<EventFormValue>;
  submitLabel: string;
  onSubmit: (v: EventFormValue) => Promise<unknown>;
  onCancel?: () => void;
  datesHint?: string;
  extra?: ReactNode; // more fields, under the name (a planned event's venue)
}) {
  const styles = useStyles();
  const theme = useTheme();
  const [name, setName] = useState(initial?.name ?? '');
  const [start, setStart] = useState(typedDay(initial?.start ?? null));
  const [end, setEnd] = useState(typedDay(initial?.end ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');

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

  const input = StyleSheet.flatten([styles.input, { color: text }]);
  return (
    <View style={styles.form}>
      <Text style={styles.label}>Name</Text>
      <TextInput value={name} onChangeText={setName} placeholder="e.g. GT4 Germany Hockenheim" placeholderTextColor={theme.textMuted}
        style={input} maxLength={160} accessibilityLabel="Event name" />
      {extra}
      <View style={styles.dates}>
        <View style={styles.date}>
          <Text style={styles.label}>First day</Text>
          <TextInput value={start} onChangeText={setStart} placeholder="dd/mm/yyyy" placeholderTextColor={theme.textMuted}
            style={input} maxLength={10} inputMode="numeric" accessibilityLabel="First day" />
        </View>
        <View style={styles.date}>
          <Text style={styles.label}>Last day</Text>
          <TextInput value={end} onChangeText={setEnd} placeholder="dd/mm/yyyy" placeholderTextColor={theme.textMuted}
            style={input} maxLength={10} inputMode="numeric" accessibilityLabel="Last day" />
        </View>
      </View>
      <Text style={styles.hint}>{datesHint ?? 'Leave the dates empty to take them from the logs.'}</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.buttons}>
        <Pressable onPress={submit} disabled={busy} accessibilityRole="button"
          style={StyleSheet.flatten([styles.button, { borderColor: tint }])}>
          {busy ? <ActivityIndicator color={tint} />
            : <Text style={StyleSheet.flatten([styles.buttonText, { color: tint }])}>{submitLabel}</Text>}
        </Pressable>
        {onCancel && (
          <Pressable onPress={onCancel} accessibilityRole="button" style={styles.cancel}>
            <Text style={{ color: tint }}>Cancel</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  form: { gap: 6, backgroundColor: 'transparent' },
  label: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.control, paddingHorizontal: 12, paddingVertical: 9,
    fontSize: 16, backgroundColor: c.surface },
  dates: { flexDirection: 'row', gap: 10, backgroundColor: 'transparent' },
  date: { flex: 1, gap: 6, backgroundColor: 'transparent' },
  hint: { fontSize: 12, opacity: 0.6 },
  error: { color: c.error },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 4, backgroundColor: 'transparent' },
  button: { borderWidth: 1.5, borderRadius: Radius.control, paddingHorizontal: 18, paddingVertical: 9, minWidth: 110,
    alignItems: 'center' },
  buttonText: { fontWeight: '700' },
  cancel: { paddingVertical: 10 },
}));
