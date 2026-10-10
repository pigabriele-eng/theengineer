// The racing line's 3D view is drawn on the web only (components/racingline/Scene3D.web.tsx, with three.js); on the
// phone app it is one line saying so, and the numbers, the chart and the table below follow the scrub bar as usual.
import { Text, View } from '@/components/Themed';
import type { SceneProps } from '@/components/racingline/types';
import { Fonts, themed } from '@/constants/Theme';

export function Scene3D(_props: SceneProps) {
  const styles = useStyles();
  return (
    <View style={styles.box}>
      <Text style={styles.note}>The 3D view is on the web version of the app; the numbers below follow the scrub bar.</Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.rule, paddingVertical: 12 },
  note: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text },
}));
