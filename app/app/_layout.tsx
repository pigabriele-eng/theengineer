import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { useColorScheme } from '@/components/useColorScheme';
import { authEnabled, useAuthSession } from '@/lib/auth';

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

function RootLayoutNav({ signedIn }: { signedIn: boolean }) {
  const colorScheme = useColorScheme();

  // Without Supabase configured, signedIn is always true and there is no sign-in screen.
  // Every route other than sign-in must be listed in the first group: a route left out stays reachable when signed out.
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="session/[id]" options={{ title: 'Session' }} />
          <Stack.Screen name="report" options={{ title: 'Report' }} />
          <Stack.Screen name="debrief/[id]" options={{ title: 'Debrief report' }} />
          <Stack.Screen name="tools/pressures" />
          <Stack.Screen name="tools/tyre-temps" />
          <Stack.Screen name="tools/tyre-fit" />
          <Stack.Screen name="tools/vehicle" />
          <Stack.Screen name="tools/stint" />
          <Stack.Screen name="tools/setup" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" options={{ headerShown: false, title: 'Sign in' }} />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  );
}
