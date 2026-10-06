import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import 'react-native-reanimated';

import { Backdrop } from '@/components/Backdrop';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { authEnabled, useAuthSession } from '@/lib/auth';
import { NoteLaunch } from '@/lib/openCurrent';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  // Ensure that reloading a session page keeps a back button present.
  initialRouteName: '(tabs)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });
  // Keep the splash screen up until the stored session has been read, so a signed-in user never sees sign-in flash by.
  const auth = useAuthSession();
  const ready = loaded && !auth.loading;

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (ready) {
      SplashScreen.hideAsync();
    }
  }, [ready]);

  if (!ready) {
    return null;
  }

  return <RootLayoutNav signedIn={!authEnabled || auth.session != null} />;
}

// Pages are see-through on the web, so the race-track picture behind the navigator shows on every page. On iOS and
// Android only the tabs are: a pushed page slides in over the one below, so it keeps a solid background.
const SEE_THROUGH = { contentStyle: { backgroundColor: 'transparent' } };

function RootLayoutNav({ signedIn }: { signedIn: boolean }) {
  const colorScheme = useColorScheme();
  const c = Colors[colorScheme];
  // React Navigation's headers, tab bar and page backgrounds in the app's colours
  const theme = useMemo(() => {
    const base = colorScheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      // on the web the pages are see-through: the root view below paints the page colour and the picture
      colors: { ...base.colors, primary: c.tint, background: Platform.OS === 'web' ? 'transparent' : c.background,
        card: c.tabBar, text: c.text, border: c.border, notification: c.error },
    };
  }, [colorScheme, c]);
  // the browser's own pieces (scrollbars, date fields, the page behind the app) in the same scheme
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.documentElement.style.colorScheme = colorScheme;
    document.body.style.backgroundColor = c.background;
  }, [colorScheme, c]);

  // Without Supabase configured, signedIn is always true and there is no sign-in screen.
  // Every route other than sign-in must be listed in the first group: a route left out stays reachable when signed out.
  return (
    <ThemeProvider value={theme}>
      <View style={StyleSheet.flatten([styles.root, { backgroundColor: c.background }])}>
        <Backdrop />
        {/* where the app was opened: on the event list while an event is on, it goes on to that event's page */}
        <NoteLaunch />
        <Stack screenOptions={Platform.OS === 'web' ? SEE_THROUGH : undefined}>
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false, ...SEE_THROUGH }} />
            <Stack.Screen name="event/[id]" options={{ title: 'Event' }} />
            <Stack.Screen name="session/[id]" options={{ title: 'Session' }} />
            <Stack.Screen name="report" options={{ title: 'Report' }} />
            <Stack.Screen name="technique" options={{ title: 'Technique check' }} />
            <Stack.Screen name="quali" options={{ title: 'Quali prep' }} />
            <Stack.Screen name="debrief/[id]" options={{ title: 'Debrief report' }} />
            <Stack.Screen name="tools/pressures" />
            <Stack.Screen name="tools/tyre-temps" />
            <Stack.Screen name="tools/tyre-fit" />
            <Stack.Screen name="tools/vehicle" />
            <Stack.Screen name="tools/stint" />
            <Stack.Screen name="tools/setup" />
            <Stack.Screen name="tools/calendar" options={{ title: 'Racing calendar' }} />
            <Stack.Screen name="garage" options={{ title: 'Cars, drivers and teams' }} />
            <Stack.Screen name="drivers/tag" options={{ title: 'Tag drivers' }} />
            <Stack.Screen name="drivers/compare" options={{ title: 'Compare drivers' }} />
            <Stack.Screen name="compare" options={{ title: 'Compare laps' }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="sign-in" options={{ headerShown: false, title: 'Sign in' }} />
          </Stack.Protected>
        </Stack>
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
