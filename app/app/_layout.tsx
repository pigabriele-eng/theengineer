import { Anton_400Regular } from '@expo-google-fonts/anton/400Regular';
import { ArchivoNarrow_400Regular } from '@expo-google-fonts/archivo-narrow/400Regular';
import { ArchivoNarrow_500Medium } from '@expo-google-fonts/archivo-narrow/500Medium';
import { ArchivoNarrow_600SemiBold } from '@expo-google-fonts/archivo-narrow/600SemiBold';
import { ArchivoNarrow_700Bold } from '@expo-google-fonts/archivo-narrow/700Bold';
import { Newsreader_400Regular } from '@expo-google-fonts/newsreader/400Regular';
import { Newsreader_400Regular_Italic } from '@expo-google-fonts/newsreader/400Regular_Italic';
import { Newsreader_600SemiBold } from '@expo-google-fonts/newsreader/600SemiBold';
import { Newsreader_700Bold } from '@expo-google-fonts/newsreader/700Bold';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Masthead } from '@/components/Programme';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { authEnabled, useAuthSession } from '@/lib/auth';
import { installFocusRing } from '@/lib/focusRing';
import { NoteLaunch } from '@/lib/openCurrent';
import { installPrint } from '@/lib/print';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  // A page loaded fresh keeps the race weekends under it (the masthead's Back still goes up to the page above it,
  // components/Back.tsx).
  initialRouteName: '(tabs)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  // The programme's faces (constants/Theme.ts FACES), loaded before the first page is drawn
  const [loaded, error] = useFonts({
    Anton_400Regular,
    Newsreader_400Regular,
    Newsreader_400Regular_Italic,
    Newsreader_600SemiBold,
    Newsreader_700Bold,
    ArchivoNarrow_400Regular,
    ArchivoNarrow_500Medium,
    ArchivoNarrow_600SemiBold,
    ArchivoNarrow_700Bold,
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

function RootLayoutNav({ signedIn }: { signedIn: boolean }) {
  const colorScheme = useColorScheme();
  const c = Colors[colorScheme];
  // React Navigation's headers and page backgrounds on the paper, in the app's colours
  const theme = useMemo(() => {
    const base = colorScheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: { ...base.colors, primary: c.tint, background: c.background, card: c.background, text: c.text,
        border: c.rule, notification: c.error },
    };
  }, [colorScheme, c]);
  // No header bar on any page: each page has its own headline, and the masthead's Back (components/Back.tsx) is the one
  // way back, in the same place on every page. A page's title still names the browser's tab.
  const screenOptions = useMemo(() => ({
    headerShown: false,
    contentStyle: { backgroundColor: c.background },
  }), [c]);
  // the print styles (lib/print.ts), so a page prints right from the browser's own Print menu too
  useEffect(() => installPrint(), []);
  // the browser's own pieces (scrollbars, date fields, the page behind the app) in the same scheme
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.documentElement.style.colorScheme = colorScheme;
    document.body.style.backgroundColor = c.background;
    installFocusRing(c.text);
  }, [colorScheme, c]);

  // Without Supabase configured, signedIn is always true and there is no sign-in screen.
  // Every route other than sign-in must be listed in the first group: a route left out stays reachable when signed out.
  return (
    <ThemeProvider value={theme}>
      <View style={StyleSheet.flatten([styles.root, { backgroundColor: c.background }])}>
        {/* where the app was opened: on the event list while an event is on, it goes on to that event's page */}
        <NoteLaunch />
        {/* the masthead and its four text links take the place of a tab bar, above every page */}
        {signedIn && <Masthead />}
        <Stack screenOptions={screenOptions}>
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="event/[id]" options={{ title: 'Event' }} />
            <Stack.Screen name="session/[id]" options={{ title: 'Session' }} />
            <Stack.Screen name="report" options={{ title: 'Report' }} />
            <Stack.Screen name="technique" options={{ title: 'Technique check' }} />
            <Stack.Screen name="quali" options={{ title: 'Quali prep' }} />
            <Stack.Screen name="prep" options={{ title: 'Prep report' }} />
            <Stack.Screen name="debrief/[id]" options={{ title: 'Debrief report' }} />
            <Stack.Screen name="tools/pressures" />
            <Stack.Screen name="tools/tyre-temps" />
            <Stack.Screen name="tools/tyre-fit" />
            <Stack.Screen name="tools/vehicle" />
            <Stack.Screen name="tools/stint" />
            <Stack.Screen name="tools/setup" />
            <Stack.Screen name="tools/calendar" options={{ title: 'Racing calendar' }} />
            <Stack.Screen name="garage" options={{ title: 'Cars, drivers and teams' }} />
            <Stack.Screen name="seasons" options={{ title: 'Seasons' }} />
            <Stack.Screen name="coaching" options={{ title: 'Coaching' }} />
            <Stack.Screen name="setup" options={{ title: 'Setup' }} />
            <Stack.Screen name="drivers/index" options={{ title: 'Drivers' }} />
            <Stack.Screen name="drivers/tag" options={{ title: 'Tag drivers' }} />
            <Stack.Screen name="drivers/compare" options={{ title: 'Compare drivers' }} />
            <Stack.Screen name="drivers/fingerprints" options={{ title: 'Driver fingerprints' }} />
            <Stack.Screen name="drivers/habits" options={{ title: 'Driver habits' }} />
            <Stack.Screen name="compare" options={{ title: 'Compare laps' }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
          </Stack.Protected>
        </Stack>
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
