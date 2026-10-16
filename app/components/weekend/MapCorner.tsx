// The corner the weekend page's track map lights up (app/event/[id].tsx): a tab points at the corner it is showing
// (a corner tapped on the Driving tab, the corner read on the Stint tab), and the map, always in view beside the page
// (pinned on top on a phone), lights it with its official number.
import { createContext, useContext, useEffect } from 'react';

/** Points the map at a corner by its code ("T8", "T11-T12"), or at none. */
export const MapCorner = createContext<(code: string | null) => void>(() => {});

/** Lights `code` on the map while this is drawn with it; nothing lit once it's gone. */
export function useMapCorner(code: string | null | undefined) {
  const point = useContext(MapCorner);
  useEffect(() => {
    point(code ?? null);
    return () => point(null);
  }, [point, code]);
}
