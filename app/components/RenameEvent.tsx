// An event's name edited in place (the events list, the top of an event, the prompt after an upload): Save or Enter
// renames it on the server and hands back the event as it is now.
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { eventsApi, Folder } from '@/lib/events';

export function RenameEvent({ id, initial, onSaved, onCancel, cancelLabel = 'Cancel', autoFocus = true, large }: {
  id: number;
  initial: string;
  onSaved: (f: Folder) => void;
  onCancel: () => void;
  cancelLabel?: string;
  autoFocus?: boolean;
  large?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  const background = useThemeColor({}, 'background');

  const save = async () => {
    const name = value.trim();
    if (!name) return setError('Give the event a name.');
    setBusy(true);
    setError(null);
    try {
      onSaved(await eventsApi.update(id, { name }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <View style={styles.box}>
      <View style={styles.row}>
        <TextInput value={value} onChangeText={setValue} autoFocus={autoFocus} selectTextOnFocus maxLength={160}
          accessibilityLabel="Event name" onSubmitEditing={save} returnKeyType="done" editable={!busy}
          style={StyleSheet.flatten([styles.input, large && styles.large, { color: text }])} />
        <Pressable onPress={save} disabled={busy} accessibilityRole="button"
          style={StyleSheet.flatten([styles.save, { borderColor: tint, backgroundColor: tint }])}>
          {busy ? <ActivityIndicator color={background} />
            : <Text style={StyleSheet.flatten([styles.saveText, { color: background }])}>Save</Text>}
        </Pressable>
        <Pressable onPress={onCancel} disabled={busy} accessibilityRole="button" hitSlop={6} style={styles.cancel}>
          <Text style={{ color: tint }}>{cancelLabel}</Text>
        </Pressable>
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 4, backgroundColor: 'transparent' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', backgroundColor: 'transparent' },
  input: { flex: 1, minWidth: 160, borderWidth: 1, borderColor: '#8886', borderRadius: 8, paddingHorizontal: 10,
    paddingVertical: 8, fontSize: 16 },
  large: { fontSize: 20, fontWeight: '700' },
  save: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8, minWidth: 64, alignItems: 'center' },
  saveText: { fontWeight: '700' },
  cancel: { paddingVertical: 8 },
  error: { color: '#c8372d' },
});
