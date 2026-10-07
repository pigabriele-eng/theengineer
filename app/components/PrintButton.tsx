// "Print / Save as PDF": a text link in a page's head that opens the browser's print dialog (lib/print.ts), where the
// page can be printed or saved as a PDF named `title`. Left off the printed page itself; nothing on iOS and Android.
import { ViewStyle } from 'react-native';

import { TextLink } from '@/components/Programme';
import { View } from '@/components/Themed';
import { canPrint, noPrint, printPage } from '@/lib/print';

export default function PrintButton({ title, style }: {
  title: string; // the PDF's file name: what the page is about ("Event report · 02_ADACGT4_T01_HOC")
  style?: ViewStyle;
}) {
  if (!canPrint) return null;
  return (
    <View style={style} {...noPrint}>
      <TextLink label="Print / Save as PDF" small onPress={() => printPage(fileName(title))} />
    </View>
  );
}

// No characters a file name can't hold (a lap time's colon, a slash)
const fileName = (title: string) => title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'The Engineer';
