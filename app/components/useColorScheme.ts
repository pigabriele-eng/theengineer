import { useColorScheme as useSystemScheme } from 'react-native';

import type { Scheme } from '@/constants/Colors';
import { useAppearance } from '@/lib/appearance';

/** The scheme the app is drawn in: Light or Dark as picked in Tools › Appearance, else the device's. */
export function useColorScheme(): Scheme {
  const choice = useAppearance();
  const system = useSystemScheme();
  if (choice !== 'system') return choice;
  return system === 'dark' ? 'dark' : 'light';
}
