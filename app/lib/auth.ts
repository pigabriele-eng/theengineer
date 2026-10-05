// Sign-in with Supabase. It's only switched on when EXPO_PUBLIC_SUPABASE_URL is set at build time: without it there is
// no login and server calls go out without a token, as in local development and CI.
// Client setup follows Supabase's Expo guide: the URL polyfill and expo-sqlite's localStorage on iOS, the browser's
// localStorage on web (both polyfills do nothing on web).
import 'react-native-url-polyfill/auto';
import 'expo-sqlite/localStorage/install';
import { createClient, isAuthError, isAuthRetryableFetchError, type Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// Whether this build asks people to sign in.
export const authEnabled = !!url;

// Set when the build has a Supabase URL but no anon key, so the sign-in screen can say so instead of crashing.
export const authConfigError =
  url && !anonKey ? 'Sign-in is not set up: EXPO_PUBLIC_SUPABASE_ANON_KEY is missing from this build.' : null;

export const supabase =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          storage: localStorage,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
      })
    : null;

// Browsers refresh the session only while the tab is visible; on iOS we have to say when the app is in the foreground.
if (supabase && Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}

// The current session ({ loading: true } until it has been read from storage). Without sign-in, never loading, no session.
export function useAuthSession(): { loading: boolean; session: Session | null } {
  const [state, setState] = useState<{ loading: boolean; session: Session | null }>({
    loading: supabase != null,
    session: null,
  });
  useEffect(() => {
    if (!supabase) return;
    // Fires straight away with the stored session (INITIAL_SESSION), then on every sign-in, refresh and sign-out.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setState({ loading: false, session }));
    return () => data.subscription.unsubscribe();
  }, []);
  return state;
}

// The access token for the server, refreshed first if it has expired; null when signed out or sign-in is off.
export async function accessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

let signOutReason: string | null = null;

// Why the last sign-out happened, when it wasn't the user's choice (shown on the sign-in screen).
export const lastSignOutReason = () => signOutReason;

// Ends this device's session; the root layout then shows the sign-in screen.
export async function signOut(reason?: string) {
  if (!supabase) return;
  signOutReason = reason ?? null;
  await supabase.auth.signOut({ scope: 'local' });
}

export async function signIn(email: string, password: string): Promise<string | null> {
  if (!supabase) return authConfigError ?? 'Sign-in is not set up for this build.';
  if (!email.trim() || !password) return 'Enter your email address and password.';
  signOutReason = null;
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  return error ? signInMessage(error) : null;
}

// Supabase's errors, in plain English.
function signInMessage(error: unknown): string {
  if (isAuthRetryableFetchError(error)) return "Can't reach the sign-in service. Check your connection and try again.";
  if (!isAuthError(error)) return 'Sign-in failed. Please try again.';
  switch (error.code) {
    case 'invalid_credentials':
      return "That email and password don't match. Check both and try again.";
    case 'email_not_confirmed':
      return "This account's email address hasn't been confirmed yet.";
    case 'user_banned':
      return 'This account has been disabled.';
    case 'email_address_invalid':
    case 'validation_failed':
      return "Check the email address: it doesn't look valid.";
    case 'over_request_rate_limit':
      return 'Too many attempts. Wait a minute, then try again.';
  }
  if (error.status === 429) return 'Too many attempts. Wait a minute, then try again.';
  if (error.status != null && error.status >= 500) return 'The sign-in service is having a problem. Try again shortly.';
  return error.message || 'Sign-in failed. Please try again.';
}
