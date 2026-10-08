// The tyres on every run row (Gabriele, 2026-10-08: "give me the ability to manually quickly edit the tire on the
// run"): a tag beside the run's driver, "New", "Fresh", "Used" or "Very used", a guess with a "?" in the muted ink
// (as the driver tag shows its guess), the driver's own pick plainly. One tap on it opens the four levels under the row
// (components/TyrePicks.tsx TyreRowView), a second saves one and closes them: two taps, no menu. Escape or the tag again
// closes them too. Every list of an event's runs reads the event's tyres once (GET /technique/events/{id}/tyres) into
// one shared state, so a pick shows at once wherever the run is listed (the weekend page's runs, its side by side, the
// During tab's Run comparison and the Laps tab, the home page, the run page, the hold menu's Tyres), and the event's
// tyres are read again after it: a run's pick changes the guesses of the runs after it on the same set. Runs in no
// event have no tag (the tyres are guessed and set per event). What the tag says and what a tap sends: lib/tyreTag.ts.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, View as Box, StyleSheet, ViewStyle } from 'react-native';

import { ErrorLine, Note } from '@/components/Controls';
import { Label } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { TyreRowView } from '@/components/TyrePicks';
import { eventTyres, setSessionTyres } from '@/lib/eventTyres';
import { TYRE_LABEL, TyreLevel } from '@/lib/tyreLevels';
import { codeOf } from '@/lib/driverTag';
import { choiceSpeech, picked, rowOf, TyreRow } from '@/lib/tyrePicks';
import { merged, tagSpeech, tapSends, toggled, tyreTag } from '@/lib/tyreTag';
import { Fonts, TAP, tapRoom, themed, Type } from '@/constants/Theme';

const web = Platform.OS === 'web';

type Rows = Map<number, TyreRow>;
type State = {
  rows: Rows | null; // null until first read
  runs: { id: number; driver: string | null }[] | null; // every run of the event in the order they ran, tyres or not
  picks: number; // picks saved here: what is worked out from the tyres (the Laps tab's suggestions) is asked again
  error: string | null; // the read failed
  saving: ReadonlySet<number>;
  errors: Readonly<Record<number, string>>; // a run's pick that wasn't saved, and why
};
const START: State = { rows: null, runs: null, picks: 0, error: null, saving: new Set(), errors: {} };

const withRow = (rows: Rows | null, row: TyreRow) => new Map(rows ?? []).set(row.id, row);
const without = (ids: ReadonlySet<number>, id: number) => {
  const out = new Set(ids);
  out.delete(id);
  return out;
};

/** One event's tyres, shared by every list of its runs on every page: read once, again when a page asks with a new
 * `version` (its runs were read again) and after each pick. */
class EventTyres {
  state: State = START;
  private subs = new Set<() => void>();
  private reading: Promise<void> | null = null;
  private again = false;
  private reads = 0; // reads started
  // runs picked here, and the first read that knows of the pick: until it, a read keeps the pick as shown
  private pending = new Map<number, number>();
  private version: unknown;

  constructor(private eventId: number) {}

  subscribe = (f: () => void) => {
    this.subs.add(f);
    return () => {
      this.subs.delete(f);
    };
  };
  get = () => this.state;
  private set(p: Partial<State>) {
    this.state = { ...this.state, ...p };
    this.subs.forEach((f) => f());
  }

  read(): Promise<void> {
    if (this.reading) {
      this.again = true; // asked while a read is out: one more once it is in
      return this.reading;
    }
    const no = ++this.reads;
    this.reading = eventTyres(this.eventId).then((t) => {
      const rows: Rows = new Map();
      for (const r of t.runs) {
        const row = rowOf(r);
        if (row) rows.set(r.id, row);
      }
      const keep = [...this.pending].filter(([, from]) => from > no).map(([id]) => id);
      for (const [id, from] of [...this.pending]) if (from <= no) this.pending.delete(id);
      this.set({ rows: merged(rows, this.state.rows, keep), runs: t.runs.map(({ id, driver }) => ({ id, driver })),
        error: null });
    }, (e) => this.set({ error: (e as Error).message })).finally(() => {
      this.reading = null;
      if (this.again) {
        this.again = false;
        void this.read();
      }
    });
    return this.reading;
  }

  /** Read now unless already read for this `version`. Left out, any read will do: one is started only if none is out
   * once the page's other lists have asked (a list inside a page asks before the page does, and the page's own
   * read, with its version, counts). */
  want(version: unknown) {
    if (version !== undefined) {
      if (version === this.version) return;
      this.version = version;
      void this.read();
    } else if (!this.state.rows && !this.reading) {
      void Promise.resolve().then(() => {
        if (!this.state.rows && !this.reading) void this.read();
      });
    }
  }

  /** The run's tyres set to `level` (shown at once), then the event's read again; false when it wasn't saved. */
  save = async (id: number, level: TyreLevel): Promise<boolean> => {
    const row = this.state.rows?.get(id);
    if (!row) return false;
    const put = tapSends(row, level);
    if (!put) return true;
    const { [id]: _, ...errors } = this.state.errors;
    this.pending.set(id, Infinity);
    this.set({ rows: withRow(this.state.rows, picked(row, level)), saving: new Set(this.state.saving).add(id), errors });
    try {
      await setSessionTyres(put.id, put.tyres);
      this.pending.set(id, this.reads + 1);
      this.set({ saving: without(this.state.saving, id), picks: this.state.picks + 1 });
      void this.read(); // the guesses of the runs after it follow from it
      return true;
    } catch (e) {
      this.pending.delete(id);
      this.set({ rows: withRow(this.state.rows, row), saving: without(this.state.saving, id),
        errors: { ...this.state.errors, [id]: `Not saved: ${(e as Error).message}` } });
      return false;
    }
  };
}

const events = new Map<number, EventTyres>();
const eventOf = (id: number) => {
  let e = events.get(id);
  if (!e) events.set(id, (e = new EventTyres(id)));
  return e;
};
const nothing = { subscribe: () => () => {}, get: () => START };

/** One list's tyres tags: the event's shared tyres, whose levels are open (one run at a time) and what a tap does.
 * `eventId` null: runs in no event, no tags. `version`: read again when it changes (the page read its runs again). */
export function useTyreTags(eventId: number | null | undefined, version?: unknown) {
  const store = eventId != null ? eventOf(eventId) : null;
  const state = useSyncExternalStore(store?.subscribe ?? nothing.subscribe, store?.get ?? nothing.get,
    store?.get ?? nothing.get);
  useEffect(() => {
    store?.want(version);
  }, [store, version]);
  const [open, setOpen] = useState<number | null>(null);
  const tags = useRef(new Map<number, Box | null>()); // each run's tag, to give the focus back to (the web)
  const focusTag = useCallback((id: number) => {
    if (web) (tags.current.get(id) as unknown as HTMLElement | null | undefined)?.focus?.();
  }, []);
  const close = useCallback((id: number) => {
    setOpen((o) => (o === id ? null : o));
    focusTag(id);
  }, [focusTag]);
  const pick = useCallback(async (id: number, level: TyreLevel) => {
    if (!store) return;
    setOpen(null);
    focusTag(id);
    if (!(await store.save(id, level))) setOpen(id); // not saved: open again, with why
  }, [store, focusTag]);
  return useMemo(() => ({
    state,
    open,
    rowOf: (id: number) => state.rows?.get(id) ?? null,
    toggle: (id: number) => setOpen((o) => toggled(o, id)),
    show: (id: number) => setOpen(id), // from the hold menu's Tyres
    close,
    pick,
    tagRef: (id: number) => (el: Box | null) => {
      tags.current.set(id, el);
    },
  }), [state, open, close, pick]);
}
export type TyreTags = ReturnType<typeof useTyreTags>;

/** The tag on a run's line: its tyres, a tap target the line's height (the words stay where they are drawn). Nothing
 * when the app has no tyres for the run. `size`: the driver tag's beside it. */
export function TyreTag({ tags, id, run, size = 17 }: { tags: TyreTags; id: number; run: string; size?: number }) {
  const styles = useStyles();
  const tag = tyreTag(tags.rowOf(id), TYRE_LABEL);
  if (!tag) return null;
  const open = tags.open === id;
  return (
    <Pressable ref={tags.tagRef(id)} onPress={() => tags.toggle(id)} accessibilityRole="button"
      accessibilityLabel={tagSpeech(tag, run)} accessibilityState={{ expanded: open }} style={styles.press}>
      <Text numberOfLines={1} style={StyleSheet.flatten([tag.mine ? styles.mine : styles.guess, open && styles.open,
        { fontSize: size }])}>
        {tag.text}
      </Text>
    </Pressable>
  );
}

/** The run's four levels, under its row while its tag is open: the run's name and Close over a rule, then the levels
 * with the one it's on ticked (and its guess and why). A tap on one saves it and closes them. */
export function TyreChoices({ tags, id, name, style }: { tags: TyreTags; id: number; name: string; style?: ViewStyle }) {
  if (tags.open !== id) return null;
  return <Choices tags={tags} id={id} name={name} style={style} />;
}

function Choices({ tags, id, name, style }: { tags: TyreTags; id: number; name: string; style?: ViewStyle }) {
  const styles = useStyles();
  const box = useRef<Box>(null);
  const row = tags.rowOf(id);
  const { close } = tags;
  // on the web: the focus to the level the run is on (a click shows no ring; the levels follow the row in the page,
  // after its other controls), and Escape closes them
  const ticked = row ? choiceSpeech(row, codeOf(row.driver), row.level, TYRE_LABEL[row.level]) : null;
  const first = useRef(ticked);
  useEffect(() => {
    if (!web || typeof document === 'undefined') return;
    const el = box.current as unknown as HTMLElement | null;
    const label = first.current;
    if (label) (el?.querySelector(`[aria-label="${CSS.escape(label)}"]`) as HTMLElement | null)?.focus?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close, id]);
  return (
    <View style={style}>
      <Box ref={box} style={styles.panel}>
        <View style={styles.panelHead}>
          <Label style={styles.panelName}>{`Tyres · ${name}`}</Label>
          <Pressable onPress={() => close(id)} accessibilityRole="button" accessibilityLabel={`Close the tyres of ${name}`}
            style={styles.close}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
        {row ? (
          <TyreRowView row={row} last bare saving={tags.state.saving.has(id)} error={tags.state.errors[id] ?? null}
            onPick={(k) => tags.pick(id, k)} />
        ) : tags.state.error ? <ErrorLine>{tags.state.error}</ErrorLine>
          : <Note style={styles.none}>The app has no tyres for this run.</Note>}
      </Box>
    </View>
  );
}

const useStyles = themed((c) => ({
  // the words are 21 to 23 px tall: room to a 44 px target above and below without moving the line (never under a
  // target's height, at the 15 px size too), and at least a target's width ("New" is narrower)
  press: { minWidth: TAP, minHeight: TAP, justifyContent: 'center', ...tapRoom(11) },
  // as the driver tag: the driver's pick in the ink, a guess in the muted ink; underlined, as both change with a tap
  mine: { fontFamily: Fonts.label, letterSpacing: 0.6, color: c.text, textDecorationLine: 'underline',
    textDecorationColor: c.borderStrong },
  guess: { fontFamily: Fonts.label, letterSpacing: 0.6, color: c.textMuted, textDecorationLine: 'underline',
    textDecorationStyle: 'dotted' },
  open: { textDecorationLine: 'underline', textDecorationStyle: 'solid', textDecorationColor: c.mark },

  panel: { borderTopWidth: 3, borderColor: c.rule, maxWidth: 520, marginBottom: 6 },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: c.rule },
  panelName: { flex: 1 },
  close: { minHeight: TAP, minWidth: TAP, alignItems: 'flex-end', justifyContent: 'center' },
  closeText: { ...Type.link, fontSize: 13, color: c.textSecondary },
  none: { marginVertical: 12 },
}));
