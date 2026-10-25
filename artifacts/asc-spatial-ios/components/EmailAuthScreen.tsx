import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { useAuth, useSignIn, useSignUp, useSSO } from '@clerk/expo';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from './KeyboardAwareScrollViewCompat';

WebBrowser.maybeCompleteAuthSession();

export function EmailAuthScreen({ creating = false }: { creating?: boolean }) {
  const { isSignedIn } = useAuth();
  const { signIn, errors: signInErrors, fetchStatus: signInStatus } = useSignIn();
  const { signUp, errors: signUpErrors, fetchStatus: signUpStatus } = useSignUp();
  const { startSSOFlow } = useSSO();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errors = creating ? signUpErrors : signInErrors;
  const pending = busy || signInStatus === 'fetching' || signUpStatus === 'fetching';
  const finish = async () => {
    const navigate = async ({ session }: { session: { currentTask?: unknown } | null }) => {
      if (session?.currentTask) {
        setError('Your account requires an additional security step. Complete it in the web workspace before returning.');
        return;
      }
      router.replace('/');
    };
    if (creating) await signUp.finalize({ navigate });
    else await signIn.finalize({ navigate });
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to complete sign-in. Please try again.'); }
    finally { setBusy(false); }
  };
  const submit = () => run(async () => {
    if (creating) {
      const result = await signUp.password({ emailAddress: email.trim(), password });
      if (result.error) return;
      const sent = await signUp.verifications.sendEmailCode();
      if (!sent.error) setVerifying(true);
    } else {
      const result = await signIn.password({ emailAddress: email.trim(), password });
      if (result.error) return;
      if (signIn.status === 'complete') await finish();
      else if (signIn.status === 'needs_client_trust' || signIn.status === 'needs_second_factor') {
        if (signIn.supportedSecondFactors.some(factor => factor.strategy === 'email_code')) {
          const sent = await signIn.mfa.sendEmailCode();
          if (!sent.error) setVerifying(true);
        } else setError('This account requires another security factor. Sign in through the web workspace to complete that step.');
      } else setError('Additional account information is required. Please complete sign-in in the web workspace.');
    }
  });
  const verify = () => run(async () => {
    const result = creating
      ? await signUp.verifications.verifyEmailCode({ code })
      : await signIn.mfa.verifyEmailCode({ code });
    if (result.error) return;
    if ((creating ? signUp.status : signIn.status) === 'complete') await finish();
    else setError('Additional account information is required. Please complete this step in the web workspace.');
  });
  const resend = () => run(async () => {
    if (creating) await signUp.verifications.sendEmailCode();
    else await signIn.mfa.sendEmailCode();
  });
  const google = () => run(async () => {
    const result = await startSSOFlow({ strategy: 'oauth_google', redirectUrl: AuthSession.makeRedirectUri() });
    if (result.createdSessionId && result.setActive) {
      await result.setActive({
        session: result.createdSessionId,
        navigate: async ({ session }) => {
          if (session?.currentTask) { setError('Complete the additional account security step in the web workspace.'); return; }
          router.replace('/');
        },
      });
    } else setError('Sign-in was cancelled or requires more account information. Please retry or use email sign-in.');
  });
  if (isSignedIn) return <Redirect href="/" />;
  return (
    <KeyboardAwareScrollViewCompat style={styles.page} contentContainerStyle={{ padding: 24, paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 }} bottomOffset={24} keyboardShouldPersistTaps="handled">
      <Image source={require('../assets/images/icon.png')} style={styles.logo} />
      <Text style={styles.brand}>ASC SPATIAL</Text>
      <Text style={styles.title}>{verifying ? 'Verify your email' : creating ? 'Create your account' : 'Welcome back'}</Text>
      <Text style={styles.copy}>{verifying ? `Enter the code sent to ${email}.` : 'Secure access to your field workspace. New accounts require technician approval.'}</Text>
      {verifying ? (
        <><TextInput testID="input-email-code" accessibilityLabel="Verification code" style={styles.input} value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" placeholder="Verification code" placeholderTextColor="#68747a" />
        <Pressable disabled={pending || !code} style={[styles.button, pending && styles.disabled]} onPress={verify}><Text style={styles.buttonText}>Verify email</Text></Pressable>
        <Pressable disabled={pending} onPress={resend}><Text style={styles.link}>Send a new code</Text></Pressable>
        <Pressable disabled={pending} onPress={() => { setVerifying(false); setCode(''); setError(''); }}><Text style={styles.link}>Start over</Text></Pressable></>
      ) : (
        <><Text style={styles.label}>Email address</Text><TextInput testID="input-email" accessibilityLabel="Email address" style={styles.input} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" placeholder="you@example.com" placeholderTextColor="#68747a" />
        <Text style={styles.label}>Password</Text><TextInput testID="input-password" accessibilityLabel="Password" style={styles.input} value={password} onChangeText={setPassword} secureTextEntry autoComplete={creating ? 'new-password' : 'current-password'} placeholder="Password" placeholderTextColor="#68747a" />
        <Pressable testID="button-email-submit" disabled={pending || !email || !password} style={[styles.button, (pending || !email || !password) && styles.disabled]} onPress={submit}><Text style={styles.buttonText}>{pending ? 'Please wait…' : creating ? 'Create account' : 'Sign in'}</Text></Pressable>
        <Pressable disabled={pending} style={styles.secondary} onPress={google}><Text style={styles.label}>Continue with Google</Text></Pressable>
        <Pressable disabled={pending} onPress={() => router.replace(creating ? '/sign-in' : '/sign-up')}><Text style={styles.link}>{creating ? 'Already have an account? Sign in' : 'New to ASC Spatial? Create account'}</Text></Pressable></>
      )}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {Object.values(errors.fields).map((field, index) => field?.message ? <Text key={index} style={styles.error}>{field.message}</Text> : null)}
      {errors.global?.map((entry, index) => <Text key={index} style={styles.error}>{entry.message}</Text>)}
      <View nativeID="clerk-captcha" />
      <Pressable onPress={() => router.replace('/')}><Text style={styles.link}>Back to ASC Spatial</Text></Pressable>
    </KeyboardAwareScrollViewCompat>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f5f3ed' },
  logo: { width: 64, height: 64, borderRadius: 16, marginBottom: 20 },
  brand: { fontFamily: 'DMSans_700Bold', color: '#263740', letterSpacing: 3 },
  title: { fontFamily: 'InstrumentSerif_400Regular', color: '#263740', fontSize: 40, marginVertical: 16 },
  copy: { fontFamily: 'DMSans_400Regular', color: '#68747a', lineHeight: 23, marginBottom: 24 },
  label: { fontFamily: 'DMSans_600SemiBold', color: '#263740', marginBottom: 8 },
  input: { minHeight: 52, borderWidth: 1, borderColor: '#cfd6d1', backgroundColor: '#fffefa', borderRadius: 12, padding: 14, color: '#263740', marginBottom: 20, fontSize: 16 },
  button: { backgroundColor: '#263740', borderRadius: 12, minHeight: 52, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  buttonText: { color: '#faf8f1', fontFamily: 'DMSans_600SemiBold', fontSize: 16 },
  secondary: { alignItems: 'center', padding: 14, borderWidth: 1, borderColor: '#cfd6d1', borderRadius: 12 },
  link: { color: '#82562f', paddingVertical: 16, fontFamily: 'DMSans_500Medium' },
  error: { color: '#a74f43', marginVertical: 8, lineHeight: 22 },
  disabled: { opacity: 0.5 },
});
