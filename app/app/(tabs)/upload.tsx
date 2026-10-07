import { StyleSheet } from 'react-native';

import { PageTitle } from '@/components/Controls';
import { ImportLogs } from '@/components/ImportLogs';
import { Colophon, Page } from '@/components/Programme';
import { View } from '@/components/Themed';

/** Upload runs and files: one big drop box and nothing else. Each zip or dropped folder becomes an event named after
 * it (logs from a planned event's track and days go into that event), then the usual prompts to name it follow. */
export default function UploadScreen() {
  return (
    <Page>
      <PageTitle title="Upload"
        dek="MoTeC logs with their .ldx, CSV exports, a zip of a whole test or a whole folder. Each log becomes a run, each zip or folder an event named after it; logs from a planned event’s track and days go into that event." />
      <View style={styles.drop}>
        <ImportLogs big onProgress={() => {}} />
      </View>
      <Colophon left="The Engineer · Upload" links={[
        { label: 'Sessions', href: '/' },
        { label: 'Seasons', href: '/seasons' },
        { label: 'Racing calendar', href: '/tools/calendar' },
      ]} />
    </Page>
  );
}

const styles = StyleSheet.create({
  drop: { marginTop: 24 },
});
