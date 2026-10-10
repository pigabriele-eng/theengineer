// The racing line page's colours, made from the theme's tokens (constants/Colors.ts): one colour per lap (and a
// pattern, lib/racingLineMath.ts PATTERNS, so a lap is never told by colour alone), and the 3D scene's paper, tarmac
// and ink, for Light and Dark.
//
// The lap colours are the chart palette's slots that keep 3:1 or more against the tarmac and the paper in each scheme
// (WCAG 1.4.11 for a line): blue, violet, green, orange. Light: #2a78d6, #4a3aa7, #008300, #b4441a on tarmac #E2DCCD;
// Dark: #3987e5, #9085e9, #199e70, #d95926 on tarmac #2E2B26.
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { byScheme, ramp } from '@/constants/Theme';

export type ScenePalette = {
  background: string;
  tarmac: string;
  edge: string; // the tarmac's edges, in ink
  ink: string;
  paper: string;
  muted: string;
  load: string[]; // a tyre's load, three stops from little load to much (50 % to 200 % of static)
  arrow: string; // where the car travels (its slip)
  scheme: 'light' | 'dark';
};

const { light: L, dark: D } = Colors;
const LAPS = {
  light: [L.chart.series[0], L.chart.series[6], L.chart.series[5], L.chart.seq2[1]],
  dark: [D.chart.series[0], D.chart.series[6], D.chart.series[2], D.chart.series[1]],
};

const SCENE = byScheme<Omit<ScenePalette, 'scheme' | 'load'>>((c) => ({
  background: c.background,
  tarmac: c.fill,
  edge: c.chart.axis,
  ink: c.text,
  paper: c.background,
  muted: c.textMuted,
  arrow: c.error,
}));

/** Each lap's colour, in the order of the answer's laps. */
export function useLapColors(): string[] {
  return LAPS[useColorScheme()];
}

// The load scale: one hue family, going deeper (Light) or brighter (Dark) with more load, every step 3:1 or more on
// the tarmac and the paper (Light: 3.5 to 8.8 on #E2DCCD; Dark: 3.5 to 9.9 on #2E2B26). The middle step is the
// chart palette's orange (Light seq2's deep end, Dark's hot tyre); a strip's width grows with the load too.
const LOAD = { light: ['#9a6a12', L.chart.seq2[1], '#6b1508'], dark: ['#a8742a', D.tyre.hot, '#ffd27a'] };

export function useScenePalette(): ScenePalette {
  const scheme = useColorScheme();
  return { ...SCENE[scheme], load: LOAD[scheme], scheme };
}

// a tyre's load as a share of its static load: 50 % (short, narrow) to 200 % (tall, wide), the scale's ends
export const LOAD_LO = 50;
export const LOAD_HI = 200;
export const LOAD_TICKS = [50, 100, 150, 200];
export const loadShare = (pct: number) => Math.max(0, Math.min(1, (pct - LOAD_LO) / (LOAD_HI - LOAD_LO)));
export function loadColor(pal: Pick<ScenePalette, 'load'>, pct: number) {
  const t = loadShare(pct) * (pal.load.length - 1);
  const i = Math.min(pal.load.length - 2, Math.floor(t));
  return ramp([pal.load[i], pal.load[i + 1]], t - i);
}
