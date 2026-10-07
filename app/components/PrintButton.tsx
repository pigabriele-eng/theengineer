// "Print / Save as PDF": a text link in a page's head that opens the browser's print dialog (lib/print.ts), where the
// page can be printed or saved as a PDF named `title`. In the app added to an iPhone's home screen, where Safari has no
// print dialog, it makes the PDF itself and hands it to the phone's share sheet (lib/pdf.web.ts), with a note at the
// foot of the screen while it works and if it fails. Left off the printed page itself; nothing on iOS and Android.
import { useId } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { Space, TAP, themed, Type, useTheme } from '@/constants/Theme';
import { closePdf, makePdf, PdfState, pdfInstead, sharePdf, usePdfState } from '@/lib/pdf';
import { canPrint, noPrint, printPage } from '@/lib/print';

export default function PrintButton({ title, style }: {
  title: string; // the PDF's file name: what the page is about ("Event report · 02_ADACGT4_T01_HOC")
  style?: ViewStyle;
}) {
  const owner = useId();
  const pdf = usePdfState();
  if (!canPrint) return null;
  const name = fileName(title);
  return (
    <View style={style} {...noPrint}>
      <TextLink label="Print / Save as PDF" small
        onPress={() => (pdfInstead ? makePdf(name, owner) : printPage(name))} />
      {pdf.step !== 'idle' && pdf.owner === owner ? <PdfNote state={pdf} /> : null}
    </View>
  );
}

// No characters a file name can't hold (a lap time's colon, a slash)
const fileName = (title: string) => title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'The Engineer';

// The note at the foot of the screen while the PDF is made (the page can't be touched meanwhile), when it waits for a
// tap to open the share sheet, and when it couldn't be made
function PdfNote({ state }: { state: Exclude<PdfState, { step: 'idle' }> }) {
  const styles = useStyles();
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const words = state.step === 'making' ? 'Making the PDF…'
    : state.step === 'ready' ? 'The PDF is ready.'
      : `The PDF couldn't be made. ${state.message.replace(/[.?]?$/, (end) => end || '.')} Try again, or print the page from a computer.`;
  return (
    <Modal transparent visible animationType="none" onRequestClose={closePdf}>
      <View style={styles.veil} {...noPrint}>
        <View style={StyleSheet.flatten([styles.note, { paddingBottom: Space.page + insets.bottom }])}
          aria-live="polite">
          <View style={styles.line}>
            {state.step === 'making' ? <ActivityIndicator color={c.text} /> : null}
            <Text style={state.step === 'failed' ? styles.failed : styles.words}>{words}</Text>
          </View>
          {state.step !== 'making' ? (
            <View style={styles.actions}>
              {state.step === 'ready' ? <NoteAction label="Share the PDF" onPress={sharePdf} /> : null}
              <NoteAction label="Close" onPress={closePdf} />
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function NoteAction({ label, onPress }: { label: string; onPress: () => void }) {
  const styles = useStyles();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.action}>
      <View style={styles.underline}>
        <Text style={styles.actionText}>{label}</Text>
      </View>
    </Pressable>
  );
}

const useStyles = themed((c) => ({
  veil: { flex: 1, justifyContent: 'flex-end' },
  note: { backgroundColor: c.background, borderTopWidth: 3, borderColor: c.rule, paddingTop: 14,
    paddingHorizontal: Space.gutterPhone, gap: 6 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, maxWidth: 640 },
  words: { fontSize: 16, lineHeight: 22, color: c.text, flexShrink: 1 },
  failed: { fontSize: 16, lineHeight: 22, color: c.error, flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24 },
  action: { minHeight: TAP, minWidth: TAP, justifyContent: 'center' },
  underline: { alignSelf: 'flex-start', borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 1 },
  actionText: { ...Type.link, fontSize: 16, lineHeight: 20, color: c.text },
}));
