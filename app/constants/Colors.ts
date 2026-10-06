// Every colour the app uses, by the job it does, for the light and the dark scheme. Screens never write a colour of
// their own: they take these tokens (useTheme() / themed() in constants/Theme.ts, or useThemeColor in Themed.tsx), so
// a change of look is a change of this file.
//
// Chart and colour-coding steps come from the chart palette method (categorical slots in a fixed order, each mode with
// its own steps checked against that mode's card surface, status colours kept apart from series colours). Colour never
// carries a meaning alone: every coloured mark keeps its label, sign or icon.

export type Scheme = 'light' | 'dark';

export type Palette = {
  // Page and surfaces. `background` is the page plane (the race-track picture sits on it); `surface` is the solid
  // colour of cards, charts, track maps and inputs above it; `surfaceRaised` marks a hovered, pressed or selected row.
  background: string;
  surface: string;
  surfaceRaised: string;
  // Ink
  text: string;
  textSecondary: string;
  textMuted: string; // placeholders, axis labels, hints
  // Lines and fills
  border: string; // card and control outlines
  borderStrong: string; // checkboxes, side rules of notes, the dashed outline of something not set
  separator: string; // row dividers inside a card
  fill: string; // progress tracks, small tags, a drop target being hovered
  // The accent: primary actions, the selected tab, chip or option, links. Nothing else.
  tint: string;
  onTint: string; // text and spinners on a tint-filled button
  tintSoft: string; // the wash behind a selected chip or row
  // Messages
  error: string;
  warning: string; // warning text
  success: string; // success text
  // Navigation
  tabBar: string;
  tabIconDefault: string;
  tabIconSelected: string;
  // The race-track picture behind the pages (constants/Theme.ts BACKGROUND), how much of it shows
  backdropOpacity: number;

  chart: ChartTokens;
  // Colour coding: one meaning, one colour, everywhere in the app
  delta: DeltaTokens;
  phase: Record<PhaseKey, string>;
  tyre: Record<TyreState, string>;
  balance: { under: string; over: string; neutral: string };
  section: string[]; // track-map sections, in order: the chip or card naming a section wears the same colour
  lap: Record<LapStatus, string>;
  event: Record<EventWhen, string>;
  status: { good: string; warning: string; serious: string; critical: string; none: string };
};

export type ChartTokens = {
  surface: string; // = Palette.surface: charts sit on a solid card
  ink: string;
  ink2: string;
  muted: string; // axis labels, de-emphasised marks
  grid: string; // hairline gridlines
  axis: string; // baselines and axes
  other: string; // a grey for context marks ("other laps")
  series: string[]; // categorical slots 1-8, fixed order
  seq: [string, string]; // one-hue ramp for magnitude (blue), near-surface end first
  seq2: [string, string]; // a second one-hue ramp (orange) when two magnitudes show at once
  speed: string[]; // the track map's speed ramp, slow (near the surface) to fast
  ideal: string; // the theoretical lap in lap comparisons
};

// Time against a reference: gains green, losses red, with a grey midpoint; `steps` grow with the size of the delta.
export type DeltaTokens = {
  gain: string; // text and marks
  loss: string;
  even: string; // no real difference
  gainSteps: string[]; // washes, weakest first
  lossSteps: string[];
};

export type PhaseKey = 'braking' | 'turnIn' | 'mid' | 'traction' | 'throttle';
export type TyreState = 'cold' | 'ok' | 'hot';
export type LapStatus = 'fastest' | 'clean' | 'outIn' | 'pit' | 'flag';
export type EventWhen = 'past' | 'current' | 'upcoming';

const light: Palette = {
  background: '#ffffff',
  surface: '#ffffff',
  surfaceRaised: '#f2f2f0',
  text: '#0b0b0b',
  textSecondary: '#52514e',
  textMuted: '#7a7975',
  border: '#d9d8d3',
  borderStrong: '#a9a8a2',
  separator: '#e8e7e3',
  fill: '#ecebe7',
  tint: '#1f6fd1',
  onTint: '#ffffff',
  tintSoft: '#e6effb',
  error: '#c8372d',
  warning: '#9a5b00',
  success: '#006300',
  tabBar: '#ffffff',
  tabIconDefault: '#9a9993',
  tabIconSelected: '#1f6fd1',
  backdropOpacity: 1,

  chart: {
    surface: '#ffffff',
    ink: '#0b0b0b',
    ink2: '#52514e',
    muted: '#898781',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    other: '#b4b2aa',
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    seq: ['#cde2fb', '#184f95'],
    seq2: ['#fbe1d4', '#b4441a'],
    speed: ['#b7d3f6', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281', '#0d366b'],
    ideal: '#52514e',
  },
  delta: {
    gain: '#006300',
    loss: '#c8372d',
    even: '#898781',
    gainSteps: ['#e3f3e3', '#b9e2b9', '#86cc86'],
    lossSteps: ['#fbe4e2', '#f4bdb8', '#ea8f88'],
  },
  phase: { braking: '#4a3aa7', turnIn: '#e87ba4', mid: '#2a78d6', traction: '#1baf7a', throttle: '#eda100' },
  tyre: { cold: '#2a78d6', ok: '#0ca30c', hot: '#d03b3b' },
  balance: { under: '#2a78d6', over: '#e34948', neutral: '#898781' },
  section: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  lap: { fastest: '#7b3fc4', clean: '#0ca30c', outIn: '#898781', pit: '#52514e', flag: '#c98500' },
  event: { past: '#898781', current: '#0ca30c', upcoming: '#2a78d6' },
  status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', none: '#8a8a86' },
};

const dark: Palette = {
  background: '#121314',
  surface: '#1b1c1e',
  surfaceRaised: '#26272a',
  text: '#f2f2f0',
  textSecondary: '#c3c2b7',
  textMuted: '#8f8e88',
  border: '#34353a',
  borderStrong: '#5a5b61',
  separator: '#2a2b2f',
  fill: '#2c2d31',
  tint: '#5ea4f5',
  onTint: '#0b1220',
  tintSoft: '#1d2b3d',
  error: '#ff6b5e',
  warning: '#f5b23a',
  success: '#3fbf5a',
  tabBar: '#16171a',
  tabIconDefault: '#7c7b76',
  tabIconSelected: '#5ea4f5',
  backdropOpacity: 1,

  chart: {
    surface: '#1b1c1e',
    ink: '#ffffff',
    ink2: '#c3c2b7',
    muted: '#898781',
    grid: '#2c2c2a',
    axis: '#4a4a46',
    other: '#55544f',
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    seq: ['#1c3554', '#86b6ef'],
    seq2: ['#4a2617', '#f08a5d'],
    speed: ['#184f95', '#256abf', '#3987e5', '#5598e7', '#86b6ef', '#9ec5f4', '#cde2fb'],
    ideal: '#c3c2b7',
  },
  delta: {
    gain: '#3fbf5a',
    loss: '#ff6b5e',
    even: '#898781',
    gainSteps: ['#173a1f', '#1f5a2c', '#2a7f3d'],
    lossSteps: ['#45201d', '#6e2c27', '#9c3a33'],
  },
  phase: { braking: '#9085e9', turnIn: '#d55181', mid: '#3987e5', traction: '#199e70', throttle: '#c98500' },
  tyre: { cold: '#3987e5', ok: '#0ca30c', hot: '#e66767' },
  balance: { under: '#3987e5', over: '#e66767', neutral: '#898781' },
  section: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  lap: { fastest: '#a77cf0', clean: '#0ca30c', outIn: '#898781', pit: '#c3c2b7', flag: '#fab219' },
  event: { past: '#898781', current: '#0ca30c', upcoming: '#3987e5' },
  status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', none: '#8a8a86' },
};

const Colors: Record<Scheme, Palette> = { light, dark };
export default Colors;
