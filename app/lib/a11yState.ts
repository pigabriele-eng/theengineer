// What a control tells a screen reader about itself, on the phone and on the web alike: ticked, picked, open, off or
// working. iOS and Android read React Native's `accessibilityState`; react-native-web (0.21) never reads that object,
// only the flat aria-* props (and `disabled`), so without them every tick box, radio, choice and fold on the web never
// said whether it was ticked, picked or open. Spread it where a control would take `accessibilityState`:
//   <Pressable accessibilityRole="checkbox" {...a11yState({ checked: on })} />
// Pure, so `npm test` checks it (lib/a11yState.test.mjs); scripts/a11y-audit.mjs checks the built pages carry it.
import type { AccessibilityState } from 'react-native';

export type A11yState = Pick<AccessibilityState, 'checked' | 'selected' | 'expanded' | 'disabled' | 'busy'>;

export type A11yProps = {
  accessibilityState: A11yState;
  'aria-checked'?: boolean | 'mixed';
  'aria-selected'?: boolean;
  'aria-pressed'?: boolean;
  'aria-current'?: 'page' | false;
  'aria-expanded'?: boolean;
  'aria-disabled'?: boolean;
  'aria-busy'?: boolean;
};

// roles that say "picked" by aria-checked: a browser drops aria-selected on them
const TICKED = ['radio', 'checkbox', 'switch'];

/** `state` as both: `accessibilityState` for iOS and Android, the matching aria-* props for the web (on the phone they
 * say the same, so either way it reads the same). `role`: the control's role on the web, when "picked" is said there
 * by something else than aria-selected, which a browser keeps only on a tab, an option, a row or a cell: a picked
 * button is a pressed one (aria-pressed), a picked link the page it is on (aria-current, as a menu's link to this
 * page), and a radio, tick box or switch says it by aria-checked alone. */
export function a11yState(state: A11yState, role?: string): A11yProps {
  const out: A11yProps = { accessibilityState: state };
  if (state.checked != null) out['aria-checked'] = state.checked;
  if (state.selected != null) {
    if (role === 'button') out['aria-pressed'] = state.selected;
    else if (role === 'link') out['aria-current'] = state.selected ? 'page' : false;
    else if (!TICKED.includes(role ?? '')) out['aria-selected'] = state.selected;
  }
  if (state.expanded != null) out['aria-expanded'] = state.expanded;
  if (state.disabled != null) out['aria-disabled'] = state.disabled;
  if (state.busy != null) out['aria-busy'] = state.busy;
  return out;
}
