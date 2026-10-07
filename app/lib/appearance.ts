// The Light / Dark / System choice of the Tools tab, remembered on the device: the browser's localStorage on the web,
// expo-sqlite's localStorage on iOS and Android (the storage sign-in already uses). Until one is picked the app is
// Light: the race programme as printed.
import 'expo-sqlite/localStorage/install';
import { useSyncExternalStore } from 'react';
import { Appearance as NativeAppearance, Platform } from 'react-native';

export type Appearance = 'system' | 'light' | 'dark';
export const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const KEY = 'theengineer.appearance';
const DEFAULT: Appearance = 'light';
const listeners = new Set<() => void>();

function read(): Appearance {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : DEFAULT;
  } catch {
    return DEFAULT; // storage blocked (private window...)
  }
}

// On iOS and Android the choice also goes to the system, so its own pieces (keyboard, alerts, pickers) match.
function applyToSystem(a: Appearance) {
  if (Platform.OS !== 'web') NativeAppearance.setColorScheme?.(a === 'system' ? 'unspecified' : a);
}

let current: Appearance = read();
applyToSystem(current);

export function setAppearance(next: Appearance) {
  current = next;
  applyToSystem(next);
  try {
    globalThis.localStorage?.setItem(KEY, next);
  } catch {
    // not remembered, but still applied for this visit
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// While a page is printed (lib/print.ts) the app is drawn Light whatever is chosen: dark ink on paper. Not remembered.
let printing = false;

/** Draw the app Light while printing (`on`), then go back to the chosen appearance. */
export function setPrinting(on: boolean) {
  if (printing === on) return;
  printing = on;
  listeners.forEach((l) => l());
}

const snapshot = (): Appearance => (printing ? 'light' : current);

/** The chosen appearance (Light while printing); re-renders when it changes. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
