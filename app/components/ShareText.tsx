// "Share": sends a page as plain text (the debrief report: lib/debriefText.ts) in as few taps as possible. Where the
// phone has a share sheet (iPhone Safari, Android Chrome, the iOS and Android apps) one tap opens it, with WhatsApp,
// Mail and Messages in it. A browser without one (most computers) gets the links straight away instead: WhatsApp,
// Email and Copy text. Left off the printed page.
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, Share } from 'react-native';

import { TextLink } from '@/components/Programme';
import { View } from '@/components/Themed';
import { themed } from '@/constants/Theme';
import { shareLinks } from '@/lib/debriefText';
import { noPrint } from '@/lib/print';

type WebNav = Navigator & { share?: (d: { title?: string; text?: string }) => Promise<void> };
const nav: WebNav | null = Platform.OS === 'web' && typeof navigator !== 'undefined' ? (navigator as WebNav) : null;
const sheet = Platform.OS !== 'web' || typeof nav?.share === 'function';
const canCopy = typeof nav?.clipboard?.writeText === 'function';

export default function ShareText({ title, text }: { title: string; text: () => string }) {
  const styles = useStyles();
  const [links, setLinks] = useState(!sheet);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const share = async () => {
    const message = text();
    if (Platform.OS !== 'web') {
      await Share.share({ message, title }).catch(() => undefined);
      return;
    }
    try {
      await nav!.share!({ title, text: message });
    } catch (e) {
      // closing the share sheet is not a failure; anything else falls back to the links
      if ((e as Error)?.name !== 'AbortError') setLinks(true);
    }
  };

  const copy = async () => {
    try {
      await nav!.clipboard.writeText(text());
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  const open = (url: string) => {
    if (url.startsWith('mailto:') && typeof window !== 'undefined') window.location.href = url;
    else Linking.openURL(url);
  };

  if (!links) return <View {...noPrint}><TextLink label="Share" onPress={share} small /></View>;
  return (
    <View style={styles.row} {...noPrint}>
      <TextLink label="Send by WhatsApp" onPress={() => open(shareLinks(text(), title).whatsapp)} small />
      <TextLink label="Send by email" onPress={() => open(shareLinks(text(), title).email)} small />
      {canCopy && <TextLink label={copied ? 'Copied' : 'Copy text'} onPress={copy} small />}
    </View>
  );
}

const useStyles = themed(() => ({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 20, rowGap: 8 },
}));
