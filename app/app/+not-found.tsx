import { Stack } from 'expo-router';

import { PageTitle } from '@/components/Controls';
import { Colophon, Page, TextLink } from '@/components/Programme';
import { View } from '@/components/Themed';
import { themed } from '@/constants/Theme';

// A link to a page that isn't there: the page's head and the way back to the sessions.
export default function NotFoundScreen() {
  const styles = useStyles();
  return (
    <Page>
      <Stack.Screen options={{ title: 'Not found' }} />
      <PageTitle kicker="Not found" title="No such page"
        dek="This page doesn’t exist, or the link to it is out of date." />
      <View style={styles.links}>
        <TextLink href="/" label="Back to the sessions" red arrow />
      </View>
      <Colophon left="The Engineer" right="Page not found" />
    </Page>
  );
}

const useStyles = themed(() => ({
  links: { flexDirection: 'row', marginTop: 28, marginBottom: 12 },
}));
