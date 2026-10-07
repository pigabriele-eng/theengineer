import { useColorScheme as useSystemScheme } from 'react-native';

import type { Scheme } from '@/constants/Colors';
import { useAppearance } from '@/lib/appearance';

// The web build is a single-page app (app.json web.output "single"), drawn only in the browser, so the stored choice
// and the browser's prefers-color-scheme can be read on the first render.
/** The scheme the app is drawn in: Light or Dark as picked in Tools › Appearance, else the browser's. */
export function useColorScheme(): Scheme {
  const choice = useAppearance();
  const system = useSystemScheme();
  if (choice !== 'system') return choice;
  return system === 'dark' ? 'dark' : 'light';
}
