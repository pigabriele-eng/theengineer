// An event's name edited in place (the events list, the event's page, the prompt after an upload): Save or Enter
// renames it on the server and hands back the event as it is now.
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { ErrorLine, FormActions, Input, MainButton } from '@/components/Controls';
import { TextLink } from '@/components/Programme';
import { View } from '@/components/Themed';
import { eventsApi, Folder } from '@/lib/events';

export function RenameEvent({ id, initial, onSaved, onCancel, cancelLabel = 'Cancel', autoFocus = true, large }: {
  id: number;
  initial: string;
  onSaved: (f: Folder) => void;
  onCancel: () => void;
  cancelLabel?: string;
  autoFocus?: boolean;
  large?: boolean; // the name in the page's headline face
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <Input value={value} onChangeText={setValue} autoFocus={autoFocus} selectTextOnFocus maxLength={160} large={large}
        accessibilityLabel="Event name" onSubmitEditing={save} returnKeyType="done" editable={!busy} />
      {error && <ErrorLine>{error}</ErrorLine>}
      <FormActions>
        <MainButton label="Save" onPress={save} busy={busy} />
        <TextLink onPress={onCancel} label={cancelLabel} disabled={busy} />
      </FormActions>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 10, maxWidth: 640 },
});
