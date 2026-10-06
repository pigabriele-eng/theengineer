import { ScrollView, StyleSheet } from 'react-native';

import { ImportLogs } from '@/components/ImportLogs';
import { View, useThemeColor } from '@/components/Themed';

/** Upload runs and files: one big drop box and nothing else. Each zip or dropped folder becomes an event named after
 * it (logs from a planned event's track and days go into that event), then the usual prompts to name it follow. */
export default function UploadScreen() {
  const background = useThemeColor({}, 'background');
  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.outer}>
      <View style={styles.page}>
        <ImportLogs big onProgress={() => {}} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  outer: { paddingVertical: 16, alignItems: 'center' },
  page: { width: '100%', maxWidth: 1100, paddingHorizontal: 16 },
});
