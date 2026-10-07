// On the web, a clear ring around whatever the keyboard is on: a 2 px ink outline set 2 px off the control, in the
// scheme's ink so it reads on the paper in Light and in Dark. Only for keyboard focus (:focus-visible): a tap or a
// click shows nothing. Text fields keep their own sign (their rule turns red while typing).
import { Platform } from 'react-native';

const ID = 'theengineer-focus-ring';

/** Draws the keyboard's focus ring in `ink` (the scheme's text colour); call it again when the scheme changes. */
export function installFocusRing(ink: string) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  let style = document.getElementById(ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = ID;
    document.head.appendChild(style);
  }
  style.textContent = `:focus-visible:not(input):not(textarea) { outline: 2px solid ${ink} !important; ` +
    'outline-offset: 2px !important; }';
}
