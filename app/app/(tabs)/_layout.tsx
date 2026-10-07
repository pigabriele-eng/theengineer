import { Tabs } from 'expo-router';

import { useTheme } from '@/constants/Theme';

// The four parts of the app. They are reached from the masthead's text links (components/Programme.tsx Masthead), so
// the tab bar itself is not drawn, and each page has its own headline instead of a header bar.
export default function TabLayout() {
  const c = useTheme();
  return (
    <Tabs
      tabBar={() => null}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: c.background },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Sessions' }} />
      <Tabs.Screen name="upload" options={{ title: 'Upload' }} />
      <Tabs.Screen name="debrief" options={{ title: 'Debrief' }} />
      <Tabs.Screen name="tools" options={{ title: 'Tools' }} />
    </Tabs>
  );
}
