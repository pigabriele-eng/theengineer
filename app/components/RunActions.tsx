// A run row's quick actions (Gabriele, 2026-10-07: "Quick hold/swipe to delete runs in phone app"): swipe the row to
// the left for a red Delete, or hold it for a small menu (Delete, Change driver, Rename). Delete always asks first,
// with the confirm the ticked runs' Delete… uses (components/DeleteRuns.tsx), so a stray swipe never loses a run.
// Never the only way: screen readers get the same three as actions on the row's link, the keyboard on the web opens
// the menu with the menu key or Shift+F10, and ticking runs then Delete… stays. The numbers behind the swipe and the
// one open row are in lib/swipe.ts. React Native's own PanResponder and Animated, already in the web bundle: no new
// dependency.
import { ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AccessibilityActionEvent, AccessibilityInfo, Animated, GestureResponderEvent, PanResponder, Platform, Pressable,
  StyleSheet, View as RNView, ViewStyle,
} from 'react-native';

import { DeleteRuns } from '@/components/DeleteRuns';
import { Label } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { RunsDeleted } from '@/lib/deleteRuns';
import { dragOffset, HOLD_MS, isMenuKey, openRows, REVEAL, settlesOpen, takesSwipe } from '@/lib/swipe';
import { TAP, themed, Type } from '@/constants/Theme';

export type RunAction = 'delete' | 'driver' | 'rename';
const ACTIONS: RunAction[] = ['delete', 'driver', 'rename'];
const WORDS: Record<RunAction, string> = { delete: 'Delete', driver: 'Change driver', rename: 'Rename' };

const web = Platform.OS === 'web';
// a phone or tablet's browser: holding a row there must not start selecting its words
const coarse = web && typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
const rows = openRows(); // one row open at a time, on every page

/** Whether a finger works the rows here (a phone, a tablet, a phone's browser): the swipe is said in the runs' help. */
export const byTouch = !web || coarse;

/** Spread on a page's outermost view: a touch anywhere but on the open row closes it. (On the web each open row
 * listens for that itself.) */
export const closesRows = web ? {} : { onTouchStart: () => rows.touchedPage() };

/** A run row's actions, its menu and its confirm: what's open under the row (`shown`), the hold that opens the menu
 * (`hold`, spread on the row's own buttons and links) and the actions for screen readers (`a11y`, spread on the row's
 * link). */
export function useRunActions({ onDriver, onRename }: { onDriver: () => void; onRename: () => void }) {
  const [shown, setShown] = useState<'menu' | 'delete' | null>(null);
  const byKeys = useRef(false); // the menu was opened from the keyboard: it takes the focus
  const act = (a: RunAction) => {
    if (a === 'delete') return setShown('delete');
    setShown(null);
    if (a === 'driver') onDriver();
    else onRename();
  };
  const openMenu = (keys = false) => {
    byKeys.current = keys;
    setShown('menu');
  };
  return {
    shown,
    act,
    openMenu,
    byKeys: byKeys.current,
    close: () => setShown(null),
    hold: { onLongPress: () => openMenu(), delayLongPress: HOLD_MS },
    a11y: {
      accessibilityActions: ACTIONS.map((a) => ({ name: a, label: WORDS[a] })),
      onAccessibilityAction: (e: AccessibilityActionEvent) => {
        const a = e.nativeEvent.actionName;
        if (a !== 'delete' && a !== 'driver' && a !== 'rename') return;
        act(a);
        if (a === 'delete') AccessibilityInfo.announceForAccessibility('Delete this run? The confirm is under the run.');
      },
    },
  };
}
export type RunActions = ReturnType<typeof useRunActions>;

// on the web a mouse drags nothing: only a finger swipes a row (a mouse selects its words)
const byFinger = (e: GestureResponderEvent) =>
  !web || String((e.nativeEvent as unknown as { type?: string }).type ?? '').startsWith('touch');

/** On the web: the click that follows the press `down` (a tap) is stopped before it reaches anything. A press that
 * turns into a scroll or a drag (another row's swipe) has no click: nothing is stopped then, nor later. */
function swallowClick(down: PointerEvent) {
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const up = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > 10) done();
  };
  const done = () => {
    document.removeEventListener('click', stop, true);
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('pointercancel', done, true);
  };
  document.addEventListener('click', stop, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', done, true);
  setTimeout(done, 800);
}

/** The row itself: slides left under a finger to show a red Delete behind it (the confirm opens under the row), and
 * held anywhere opens the menu. Open, a tap on the row or anywhere else slides it back (on the web, that tap does
 * nothing else). */
export function SwipeRow({ run, name, disabled, bleed, children }: {
  run: RunActions;
  name: string;
  disabled?: boolean; // while the run's name is edited in the row
  // the row's own padding above and below its line: the sliding paper and the Delete fill it, the layout unchanged
  bleed?: { top: number; bottom: number };
  children: ReactNode;
}) {
  const styles = useStyles();
  const id = useId();
  const box = useRef<RNView>(null);
  const x = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  const off = useRef(disabled);
  off.current = disabled;
  // closed: no Delete drawn at all (nothing behind the row to reach by Tab or to read); moving or open: drawn
  const [state, setState] = useState<'closed' | 'moving' | 'open'>('closed');
  const keyed = useRef(0); // when the keyboard last opened the menu: the browser's own menu that follows is kept shut

  const { pan, settle } = useMemo(() => {
    const settle = (toOpen: boolean) => {
      open.current = toOpen;
      if (toOpen) {
        rows.opening(id, () => settle(false));
        setState('open');
      } else rows.closed(id);
      Animated.timing(x, { toValue: toOpen ? -REVEAL : 0, duration: 160, useNativeDriver: !web }).start(({ finished }) => {
        if (finished && !open.current) setState('closed');
      });
    };
    const swipe = (e: GestureResponderEvent, g: { dx: number; dy: number }) =>
      !off.current && byFinger(e) && takesSwipe(g.dx, g.dy, open.current);
    const pan = PanResponder.create({
      // asked on the way down, so a sideways move is taken from the button or link it started on
      onMoveShouldSetPanResponderCapture: swipe,
      onMoveShouldSetPanResponder: swipe,
      onPanResponderGrant: () => {
        x.stopAnimation();
        rows.opening(id, () => settle(false)); // the row open before slides back
        setState('moving');
      },
      onPanResponderMove: (_, g) => x.setValue(dragOffset(g.dx, open.current)),
      onPanResponderRelease: (_, g) => settle(settlesOpen(dragOffset(g.dx, open.current), g.vx)),
      onPanResponderTerminate: () => settle(open.current),
      onPanResponderTerminationRequest: () => false, // the page's scroll doesn't take a swipe half way
    });
    return { pan, settle };
  }, [id, x]);

  useEffect(() => () => rows.closed(id), [id]);
  useEffect(() => {
    if (disabled && open.current) settle(false);
  }, [disabled, settle]);
  // on the web, a press anywhere but on this row slides it back, and does nothing else (a link there doesn't open)
  useEffect(() => {
    if (!web || state !== 'open' || typeof document === 'undefined') return;
    const node = box.current as unknown as HTMLElement | null;
    const down = (e: PointerEvent) => {
      // (closed already, sliding back: the press is the next thing's, a confirm's button say)
      if (!open.current || !node || node.contains(e.target as Node)) return;
      settle(false);
      swallowClick(e);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [state, settle]);

  const webKeys = web ? {
    onKeyDown: (e: { key?: string; shiftKey?: boolean; nativeEvent?: KeyboardEvent; preventDefault: () => void }) => {
      const k = e.nativeEvent ?? e;
      if (disabled || !isMenuKey(k.key ?? '', !!k.shiftKey)) return;
      e.preventDefault();
      keyed.current = Date.now();
      run.openMenu(true);
    },
    onContextMenu: (e: { preventDefault: () => void }) => {
      if (Date.now() - keyed.current < 1000) e.preventDefault();
    },
  } : null;

  return (
    <RNView ref={box} {...webKeys} onTouchStart={() => rows.touchedRow(id)}
      style={StyleSheet.flatten([state === 'closed' ? styles.row : styles.rowOpen,
        bleed && { marginTop: -bleed.top, marginBottom: -bleed.bottom }])}>
      {state !== 'closed' && (
        <Pressable onPress={() => {
          settle(false);
          run.act('delete');
        }} accessibilityRole="button" accessibilityLabel={`Delete ${name}`} style={styles.delete}>
          <Text style={styles.deleteText}>Delete</Text>
        </Pressable>
      )}
      <Animated.View {...pan.panHandlers}
        style={StyleSheet.flatten([styles.slide, coarse && styles.noSelect,
          bleed && { paddingTop: bleed.top, paddingBottom: bleed.bottom }, { transform: [{ translateX: x }] }])}>
        {/* held anywhere on the row (its own buttons and links take `run.hold` too): the menu. Not a stop of its own
            for the keyboard or a screen reader: the row's link carries the actions */}
        <Pressable onLongPress={disabled ? undefined : () => run.openMenu()} delayLongPress={HOLD_MS} accessible={false}
          tabIndex={-1} style={styles.hold}>
          {children}
        </Pressable>
        {state === 'open' && (
          <Pressable onPress={() => settle(false)} accessibilityRole="button"
            accessibilityLabel={`Hide Delete for ${name}`} style={styles.cover} />
        )}
      </Animated.View>
    </RNView>
  );
}

/** What opens under the row: the menu, or the confirm (the ticked runs' own, for this one run). */
export function RunPanel({ run, id, name, inEvent, onDeleted, style }: {
  run: RunActions;
  id: number;
  name: string;
  inEvent: boolean;
  onDeleted: (d: RunsDeleted) => void;
  style?: ViewStyle;
}) {
  if (run.shown === 'menu') {
    return <View style={style}><RunMenu name={name} onAction={run.act} onClose={run.close} focus={run.byKeys} /></View>;
  }
  if (run.shown === 'delete') {
    return (
      <View style={style}>
        <DeleteRuns ids={[id]} names={[name]} inEvent={inEvent} title="Delete this run" onCancel={run.close}
          onDeleted={(d) => {
            run.close();
            onDeleted(d);
          }} />
      </View>
    );
  }
  return null;
}

/** The menu a hold opens: the run's name and Close over a rule, then Delete…, Change driver and Rename, each a full
 * line to tap. */
function RunMenu({ name, onAction, onClose, focus }: {
  name: string;
  onAction: (a: RunAction) => void;
  onClose: () => void;
  focus: boolean; // opened from the keyboard: the focus goes to its first line
}) {
  const styles = useStyles();
  const first = useRef<RNView>(null);
  useEffect(() => {
    if (web && focus) (first.current as unknown as HTMLElement | null)?.focus?.();
  }, [focus]);
  // Escape closes it from the keyboard (the web)
  const keys = web ? { onKeyDown: (e: { key?: string }) => e.key === 'Escape' && onClose() } : null;
  return (
    <View style={styles.menu} {...keys}>
      <View style={styles.menuHead}>
        <Label style={styles.menuName}>{name}</Label>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={`Close the menu of ${name}`}
          style={styles.menuClose}>
          <Text style={styles.menuCloseText}>Close</Text>
        </Pressable>
      </View>
      {ACTIONS.map((a, i) => (
        <Pressable key={a} ref={i === 0 ? first : undefined} onPress={() => onAction(a)} accessibilityRole="button"
          accessibilityLabel={`${WORDS[a]} ${name}`}
          style={i < ACTIONS.length - 1 ? styles.menuItem : styles.menuLast}>
          <Text style={a === 'delete' ? styles.menuDanger : styles.menuText}>{WORDS[a]}{a === 'delete' ? '…' : ''}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const useStyles = themed((c) => ({
  row: { position: 'relative' },
  // slid: the Delete behind it, and nothing outside the row's width
  rowOpen: { position: 'relative', overflow: 'hidden' },
  // the row's own paper, over the Delete behind it; a finger's swipe up or down still scrolls the page (web)
  slide: StyleSheet.flatten([{ backgroundColor: c.background }, web ? ({ touchAction: 'pan-y' } as ViewStyle) : null]),
  noSelect: { userSelect: 'none' } as ViewStyle, // web only: a held row's words aren't selected
  hold: { cursor: 'auto' },
  cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  // the danger red of the confirm's own button, with the paper's colour on it (AA in Light and Dark)
  delete: { position: 'absolute', top: 0, right: 0, bottom: 0, width: REVEAL, minHeight: TAP, alignItems: 'center',
    justifyContent: 'center', backgroundColor: c.error },
  deleteText: { ...Type.link, fontSize: 16, color: c.background },

  menu: { borderTopWidth: 3, borderColor: c.rule, maxWidth: 420, marginBottom: 6 },
  menuHead: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: c.rule },
  menuName: { flex: 1 },
  menuClose: { minHeight: TAP, minWidth: TAP, alignItems: 'flex-end', justifyContent: 'center' },
  menuCloseText: { ...Type.link, fontSize: 13, color: c.textSecondary },
  menuItem: { minHeight: TAP + 4, justifyContent: 'center', borderBottomWidth: 1, borderColor: c.separator },
  menuLast: { minHeight: TAP + 4, justifyContent: 'center' }, // the row's own rule closes the menu
  menuText: { ...Type.link, fontSize: 16, color: c.text },
  menuDanger: { ...Type.link, fontSize: 16, color: c.error },
}));
