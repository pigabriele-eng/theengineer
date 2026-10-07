import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput } from 'react-native';

import { ErrorLine, Field, Input, MainButton } from '@/components/Controls';
import { Colophon, Hero, Page, useWide } from '@/components/Programme';
import { View } from '@/components/Themed';
import { authConfigError, lastSignOutReason, signIn } from '@/lib/auth';
import { PHOTOS, themed } from '@/constants/Theme';

// Shown instead of the app until there's a session (only in builds with Supabase configured). Accounts are created in
// Supabase, so there's no sign-up here. The programme's cover: the photo with the app's name over it, then the two
// fields on ink rules and the main action as a solid ink block. There is no masthead before signing in.
export default function SignInScreen() {
  const styles = useStyles();
  const wide = useWide();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => authConfigError ?? lastSignOutReason());
  const passwordRef = useRef<TextInput>(null);

  // On success the root layout sees the new session and swaps this screen for the app.
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const message = await signIn(email, password);
    setBusy(false);
    if (message) setError(message);
  };

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Page keyboardShouldPersistTaps="handled"
        top={<Hero photo={PHOTOS.dusk} tag="Sign in" title="The Engineer" height={wide ? 400 : 330}
          deck="Sign in to see your sessions and debriefs." />}>
        <View style={wide ? styles.form : styles.formPhone}>
          <Field label="Email">
            <Input value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none"
              autoCorrect={false} autoComplete="email" keyboardType="email-address" textContentType="username"
              returnKeyType="next" onSubmitEditing={() => passwordRef.current?.focus()} accessibilityLabel="Email" />
          </Field>
          <Field label="Password">
            <Input ref={passwordRef} value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry
              autoCapitalize="none" autoComplete="current-password" textContentType="password" returnKeyType="go"
              onSubmitEditing={submit} accessibilityLabel="Password" />
          </Field>
          {error && <ErrorLine>{error}</ErrorLine>}
          <MainButton label="Sign in" onPress={submit} busy={busy} style={styles.button} />
        </View>
        <Colophon left="The Engineer" right="Accounts are made by the team" />
      </Page>
    </KeyboardAvoidingView>
  );
}

const useStyles = themed(() => ({
  fill: { flex: 1 },
  form: { width: '100%', maxWidth: 440, gap: 22, paddingTop: 34 },
  formPhone: { width: '100%', gap: 20, paddingTop: 24 },
  button: { minWidth: 160 },
}));
