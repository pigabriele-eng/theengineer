// The masthead's Back, the one way back on every page but the race weekends (Gabriele, 2026-10-08): one page back when
// pages were visited in the app, else up to the page above (lib/backTo.ts). The masthead keeps the trail of pages
// visited in this load; a page that belongs to an event says which with useBackTo, so a run opened fresh from a link
// still goes back to its event.
import { Href, useFocusEffect, useGlobalSearchParams, useRouter } from 'expo-router';
import { useCallback, useSyncExternalStore } from 'react';
import { Pressable } from 'react-native';

import { Text } from '@/components/Themed';
import { tapRoom, themed, Type } from '@/constants/Theme';
import { backFrom, backLabel, EventRef, step } from '@/lib/backTo';

// The pages visited in this load (lib/backTo.ts step), kept for as long as the app runs.
let trail: string[] = [];

// The event of the page in view, as it set it (useBackTo), with the page that set it.
let mine: { owner: object; event: EventRef } | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const setMine = (next: typeof mine) => {
  mine = next;
  listeners.forEach((l) => l());
};

/** The event a page belongs to, for Back when there are no pages behind it (a fresh load): its id, and its name once
 * read. Set while the page is in view. Pages that have it in their address (?event=) don't need it, but their name
 * makes Back read "Back to <event>". */
export function useBackTo(event: EventRef | null | undefined) {
  const id = event?.id;
  const name = event?.name;
  useFocusEffect(
    useCallback(() => {
      if (id == null) return;
      const owner = {};
      setMine({ owner, event: { id, name } });
      return () => {
        if (mine?.owner === owner) setMine(null);
      };
    }, [id, name]),
  );
}

/** Notes the page shown (the masthead calls it with each new path): the trail Back reads. */
export function noteVisit(path: string) {
  trail = step(trail, path);
}

/** "‹ Back" in the label face, a full tap target; nothing on the race weekends. */
export function BackLink({ path }: { path: string }) {
  const styles = useStyles();
  const router = useRouter();
  const set = useSyncExternalStore(subscribe, () => mine, () => mine);
  // pages with ?event= in their address (a report, quali prep, a prep report, a prediction, a technique check)
  const params = useGlobalSearchParams<{ event?: string }>();
  const event: EventRef | null = set?.event ?? (typeof params.event === 'string' && params.event ? { id: params.event } : null);
  const back = backFrom(trail, path, event, router.canGoBack());
  if (!back) return null;
  const go = () => {
    // asked again on the press: the navigator may have changed since this was drawn
    const now = backFrom(trail, path, event, router.canGoBack());
    if (!now) return;
    if (now.to === 'history') router.back();
    else {
      // up to the page above: back to it when the navigator has it under this one, else in this page's place (a
      // fresh load); the trail starts again from there
      trail = [];
      router.dismissTo(now.place.path as Href);
    }
  };
  return (
    <Pressable onPress={go} accessibilityRole="button" accessibilityLabel={backLabel(back.place)} style={styles.hit}>
      <Text style={styles.text}>‹ Back</Text>
    </Pressable>
  );
}

const useStyles = themed((c) => ({
  // a 44 px tap target around a 20 px line, without making the masthead's row taller
  hit: { ...tapRoom(12, 6), minWidth: 44, justifyContent: 'center' },
  text: { ...Type.label, fontSize: 16, lineHeight: 20, letterSpacing: 1.4, color: c.text },
}));
