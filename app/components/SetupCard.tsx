// The Setup part of the session page: is there a sheet, what changed from the previous run, and the way in. A ruled
// sub-head ("SETUP" in Archivo capitals over a 3 px ink rule), the changes on faint rules, and text links. `bare`
// leaves the sub-head out, for a page that sets the card inside a numbered section of its own.
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';

import { TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { ErrorLine, Note, SubHead, Working } from '@/components/ToolForm';
import { setupApi, Sheet } from '@/lib/setup';
import { Fonts, themed } from '@/constants/Theme';

const SHOWN = 4;

export function SetupCard({ sessionId, bare }: { sessionId: number; bare?: boolean }) {
  const styles = useStyles();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // Again on coming back from the sheet, so the summary is current.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      setupApi.sheet(sessionId).then(
        (s) => live && setSheet(s),
        (e) => live && setError(e.message),
      );
      return () => {
        live = false;
      };
    }, [sessionId]),
  );

  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      await setupApi.copyPrevious(sessionId);
      router.push({ pathname: '/tools/setup', params: { session: sessionId } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const count = sheet ? Object.keys(sheet.values).length : 0;
  const prev = sheet?.previous?.name ?? 'the previous run';
  const line = !sheet
    ? ''
    : !sheet.exists
      ? 'No setup sheet for this run yet.'
      : !sheet.previous
        ? `${count} values on the sheet.`
        : sheet.changes.length
          ? `${count} values · ${sheet.changes.length} changed from ${prev}:`
          : `${count} values · same setup as ${prev}.`;

  return (
    <View style={styles.wrap}>
      {bare ? null : <SubHead>Setup</SubHead>}
      {!sheet && !error && <Working />}
      {line ? <Note small>{line}</Note> : null}
      {sheet && sheet.changes.length > 0 && (
        <View style={styles.changes}>
          {sheet.changes.slice(0, SHOWN).map((c) => (
            <Text key={c.key} style={styles.change}>{c.text}</Text>
          ))}
        </View>
      )}
      {sheet && sheet.changes.length > SHOWN && <Note small>and {sheet.changes.length - SHOWN} more</Note>}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <View style={styles.actions}>
        {sheet && !sheet.exists && sheet.previous && (
          <TextLink onPress={copy} disabled={busy} red label={busy ? 'Copying…' : `Copy from ${prev}`} />
        )}
        <TextLink href={{ pathname: '/tools/setup', params: { session: sessionId } }}
          label={sheet?.exists ? 'Setup sheet' : 'Fill in the sheet'} arrow red={!(sheet && !sheet.exists && sheet.previous)} />
        <TextLink href={{ pathname: '/tools/setup', params: { session: sessionId, tab: 'ideas' } }} label="Setup suggestions"
          arrow />
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  wrap: { gap: 6 },
  changes: { marginTop: 4 },
  change: { fontFamily: Fonts.label, fontSize: 15, lineHeight: 20, color: c.text, borderBottomWidth: 1,
    borderColor: c.separator, paddingVertical: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 12, marginTop: 10 },
}));
