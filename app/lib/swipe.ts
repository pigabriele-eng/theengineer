// Swiping a run row to the left to show its Delete, and holding it for its menu (Gabriele, 2026-10-07: "Quick
// hold/swipe to delete runs in phone app"): the numbers behind the gesture and which row is open, kept apart from React
// so `npm test` checks them (components/RunActions.tsx has the gesture itself).

/** How far a row slides to show its Delete: the button's width. */
export const REVEAL = 96;
/** How long a hold opens a row's menu (ms). */
export const HOLD_MS = 450;
/** How far a finger goes sideways before a row takes the gesture (px): less is a tap, or the start of a scroll. */
export const SLOP = 12;

/** Whether a move is a clear sideways swipe for the row rather than the page's scroll: SLOP sideways or more, and at
 * least twice as far sideways as up or down. Closed, only a swipe to the left counts; open, either way. */
export function takesSwipe(dx: number, dy: number, open: boolean): boolean {
  if (!(Math.abs(dx) >= SLOP) || Math.abs(dx) < 2 * Math.abs(dy)) return false;
  return open || dx < 0;
}

/** Where the row sits while a finger drags it `dx` px: from where it was (open: slid REVEAL to the left), never to the
 * right of closed, and pulled past open it follows a third as far. */
export function dragOffset(dx: number, open: boolean): number {
  const x = (open ? -REVEAL : 0) + dx;
  if (x >= 0) return 0;
  if (x < -REVEAL) return -REVEAL + (x + REVEAL) / 3;
  return x;
}

/** Whether the row stays open when the finger lifts at `offset` with speed `vx` (px/ms, left negative): a quick flick
 * decides by its direction, else past half the Delete button opens it. */
export function settlesOpen(offset: number, vx: number): boolean {
  if (vx <= -0.5) return true;
  if (vx >= 0.5) return false;
  return offset < -REVEAL / 2;
}

/** The keys that open a row's menu from the keyboard on the web: the menu key, or Shift+F10. */
export function isMenuKey(key: string, shift: boolean): boolean {
  return key === 'ContextMenu' || (shift && key === 'F10');
}

/** One row open at a time on the whole app: opening a row closes the one open before; a touch anywhere but on the
 * open row closes it (the row says it was touched before the page hears of the touch: touch events bubble up). */
export function openRows() {
  let open: { id: string; close: () => void } | null = null;
  let touched: string | null = null;
  return {
    /** Row `id` opens (or starts to slide): the row open before closes. */
    opening(id: string, close: () => void) {
      if (open && open.id !== id) open.close();
      open = { id, close };
    },
    /** Row `id` is closed (slid back, or gone). */
    closed(id: string) {
      if (open?.id === id) open = null;
    },
    /** A touch began on row `id`. */
    touchedRow(id: string) {
      touched = id;
    },
    /** A touch began on the page: the open row closes unless the touch is on it. */
    touchedPage() {
      if (open && open.id !== touched) {
        const was = open;
        open = null;
        was.close();
      }
      touched = null;
    },
    /** The row open now, if any. */
    get openId() {
      return open?.id ?? null;
    },
  };
}
