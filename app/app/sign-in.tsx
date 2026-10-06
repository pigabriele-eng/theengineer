import { useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { authConfigError, lastSignOutReason, signIn } from '@/lib/auth';
import { Radius, themed, useTheme } from '@/constants/Theme';

// Shown instead of the app until there's a session (only in builds with Supabase configured). Accounts are created in
// Supabase, so there's no sign-up here.
export default function SignInScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => authConfigError ?? lastSignOutReason());
  const passwordRef = useRef<TextInput>(null);
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  const onTint = useThemeColor({}, 'onTint');

  // On success the root layout sees the new session and swaps this screen for the app.
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const message = await signIn(email, password);
    setBusy(false);
    if (message) setError(message);
  };

  const input = [styles.input, { color: text, borderColor: theme.border }];

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.container}>
        <View style={styles.form}>
          <Text style={styles.title}>The Engineer</Text>
          <Text style={styles.sub}>Sign in to see your sessions and debriefs.</Text>

          <Text style={styles.label}>Email</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
            style={input}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            ref={passwordRef}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={theme.textMuted}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={submit}
            style={input}
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={[styles.button, { backgroundColor: tint, opacity: busy ? 0.6 : 1 }]}
            onPress={submit}
            disabled={busy}
            accessibilityRole="button">
            {busy ? (
              <ActivityIndicator color={onTint} />
            ) : (
              <Text style={[styles.buttonText, { color: onTint }]}>Sign in</Text>
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const useStyles = themed((c) => ({
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  form: { width: '100%', maxWidth: 400, alignSelf: 'center', gap: 8 },
  title: { fontSize: 28, fontWeight: '700' },
  sub: { opacity: 0.6, marginBottom: 16 },
  label: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 },
  input: { borderWidth: 1, borderRadius: Radius.control, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  error: { color: c.error, marginTop: 8 },
  button: { borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginTop: 16 },
  buttonText: { fontWeight: '600', fontSize: 16 },
}));
