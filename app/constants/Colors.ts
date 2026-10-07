// Every colour the app uses, by the job it does, for the light and the dark scheme. Screens never write a colour of
// their own: they take these tokens (useTheme() / themed() in constants/Theme.ts, or useThemeColor in Themed.tsx), so
// a change of look is a change of this file.
//
// The look is a timing screen: a near-black page (near-white in Light), no cards, full-width bands split by hairline
// rules, white as the only accent (a selected item is an inverted block), and the colour coding of a timing tower:
// purple for the overall best, green for a personal best, yellow for slower, a yellow ramp for time lost.
//
// Chart and colour-coding steps come from the chart palette method (categorical slots in a fixed order, each mode with
// its own steps checked against that mode's page surface, status colours kept apart from series colours). Colour never
// carries a meaning alone: every coloured mark keeps its label, sign or icon.

export type Scheme = 'light' | 'dark';

export type Palette = {
  // Page and surfaces. There are no cards: `surface` is the page colour too, so a box drawn with it is only its
  // hairline. `band` is the alternate band (day rows, totals), `surfaceRaised` a column-header row, a pressed or
  // selected row.
  background: string;
  surface: string;
  band: string;
  surfaceRaised: string;
  // Ink
  text: string;
  textSecondary: string;
  textMuted: string; // placeholders, axis labels, hints, labels
  // Lines and fills
  border: string; // the stronger hairline: controls, boxes, the rail's edge
  borderStrong: string; // checkboxes, side rules of notes, the dashed outline of something not set
  separator: string; // the hairline between rows and bands
  fill: string; // progress and bar tracks, small tags, a drop target being hovered
  // The accent: ink itself. Primary actions are an inverted block, links are ink.
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

  chart: ChartTokens;
  // Colour coding: one meaning, one colour, everywhere in the app
  timing: TimingTokens;
  delta: DeltaTokens;
  phase: Record<PhaseKey, string>;
  tyre: Record<TyreState, string>;
  balance: { under: string; over: string; neutral: string };
  section: string[]; // track-map sections, in order: the chip or card naming a section wears the same colour
  lap: Record<LapStatus, string>;
  event: Record<EventWhen, string>;
  status: { good: string; warning: string; serious: string; critical: string; none: string };
  medal: { gold: string; silver: string; bronze: string };
};

export type ChartTokens = {
  surface: string; // = Palette.surface: charts sit on the page
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
  wash: string; // a see-through wash of slot 1 (an area such as the car's grip limit)
  track: string; // the track drawn under a coloured line (a grey road)
  mid: string; // the neutral middle of a diverging scale (a cell with nothing to say)
};

// The timing tower's colours: a section or lap time that is the best of all (the event), the driver's or run's own best,
// or slower than that; and the ramp of time lost, from a little (near the page) to the most.
export type TimingTokens = {
  best: string; // purple: overall best
  personal: string; // green: personal (run) best
  slower: string; // yellow
  onBest: string; // text on a purple block
  bestWash: string; // the row of the fastest lap
  loss: string[]; // 5 steps, least time lost first
};

// Time against a reference: gains green, losses red as text; marks of time lost (bars, track sections) take the
// yellow time-lost ramp; `steps` grow with the size of the delta.
export type DeltaTokens = {
  gain: string; // text and marks
  loss: string;
  even: string; // no real difference
  gainRamp: [string, string]; // marks (bars, track sections), smallest to biggest difference
  lossRamp: [string, string];
  gainSteps: string[]; // washes behind text, weakest first
  lossSteps: string[];
};

export type PhaseKey = 'braking' | 'turnIn' | 'mid' | 'traction' | 'throttle';
export type TyreState = 'cold' | 'ok' | 'hot';
export type LapStatus = 'fastest' | 'clean' | 'outIn' | 'pit' | 'flag';
export type EventWhen = 'past' | 'current' | 'upcoming';

// Light: the same roles on a near-white page, each step chosen for that page (#f6f6f3) and checked with the palette
// validator: sector purple/green/yellow and tyre cold/ok/hot pass all pairs, balance and the five phases pass, the
// time-lost ramp reads in order with its lightest step at 2:1 against the page.
const light: Palette = {
  background: '#f6f6f3',
  surface: '#f6f6f3',
  band: '#efefeb',
  surfaceRaised: '#e7e7e2',
  text: '#0b0c0e',
  textSecondary: '#454a52',
  textMuted: '#646a73',
  border: '#c6c6c0',
  borderStrong: '#8f9097',
  separator: '#dcdcd6',
  fill: '#e2e2dc',
  tint: '#0b0c0e',
  onTint: '#f6f6f3',
  tintSoft: '#e7e7e2',
  error: '#c4321f',
  warning: '#8a6400',
  success: '#0b6b30',
  tabBar: '#f6f6f3',
  tabIconDefault: '#646a73',
  tabIconSelected: '#0b0c0e',

  chart: {
    surface: '#f6f6f3',
    ink: '#0b0c0e',
    ink2: '#454a52',
    muted: '#7a7f87',
    grid: '#dcdcd6',
    axis: '#b9b9b2',
    other: '#b4b4ad',
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    seq: ['#cde2fb', '#184f95'],
    seq2: ['#fbe1d4', '#b4441a'],
    speed: ['#b7d3f6', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281', '#0d366b'],
    ideal: '#454a52',
    wash: 'rgba(42,120,214,0.08)',
    track: '#dedfd9',
    mid: '#e7e7e2',
  },
  timing: {
    best: '#8338ec',
    personal: '#0b6b30',
    slower: '#b08300',
    onBest: '#ffffff',
    bestWash: 'rgba(131,56,236,0.08)',
    loss: ['#c9ac4a', '#b8962a', '#a38112', '#8c6d00', '#735900'],
  },
  delta: {
    gain: '#0b6b30',
    loss: '#d63a2a',
    even: '#7a7f87',
    gainRamp: ['#7fc98f', '#0b6b30'],
    lossRamp: ['#c9ac4a', '#735900'],
    gainSteps: ['#e1f0e4', '#c3e2ca', '#9fd0aa'],
    lossSteps: ['#f4ecd0', '#eadcaa', '#ddc87e'],
  },
  phase: { braking: '#c22a45', turnIn: '#c0700a', mid: '#7466e0', traction: '#12895f', throttle: '#2a72d0' },
  tyre: { cold: '#1f7fd6', ok: '#0a6630', hot: '#dc6a1a' },
  balance: { under: '#2a6fdb', over: '#d63a2a', neutral: '#b9b9b2' },
  section: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  lap: { fastest: '#8338ec', clean: '#0b0c0e', outIn: '#7a7f87', pit: '#454a52', flag: '#b08300' },
  event: { past: '#7a7f87', current: '#0b6b30', upcoming: '#2a72d0' },
  status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', none: '#8a8a86' },
  medal: { gold: '#c99a1e', silver: '#9aa0a8', bronze: '#b0703a' },
};

// Dark: the timing-tower mockup's colours as drawn. Sector yellow and tyre hot sit above the validator's lightness band
// on purpose: their lightness gap is what keeps them apart from green under colour blindness.
const dark: Palette = {
  background: '#0a0b0d',
  surface: '#0a0b0d',
  band: '#0f1114',
  surfaceRaised: '#15181c',
  text: '#f2f3f5',
  textSecondary: '#a9aeb6',
  textMuted: '#7d838c',
  border: '#2e3238',
  borderStrong: '#585d66',
  separator: '#1f2227',
  fill: '#1f2227',
  tint: '#f2f3f5',
  onTint: '#0a0b0d',
  tintSoft: '#15181c',
  error: '#f0503c',
  warning: '#f5b23a',
  success: '#1fa855',
  tabBar: '#0a0b0d',
  tabIconDefault: '#7d838c',
  tabIconSelected: '#f2f3f5',

  chart: {
    surface: '#0a0b0d',
    ink: '#f2f3f5',
    ink2: '#a9aeb6',
    muted: '#7d838c',
    grid: '#1f2227',
    axis: '#3a3e45',
    other: '#4a4e55',
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    seq: ['#1c3554', '#86b6ef'],
    seq2: ['#4a2617', '#f08a5d'],
    speed: ['#184f95', '#256abf', '#3987e5', '#5598e7', '#86b6ef', '#9ec5f4', '#cde2fb'],
    ideal: '#a9aeb6',
    wash: 'rgba(57,135,229,0.12)',
    track: '#24272c',
    mid: '#3a3e45',
  },
  timing: {
    best: '#a64dff',
    personal: '#1fa855',
    slower: '#f5cf2a',
    onBest: '#ffffff',
    bestWash: 'rgba(166,77,255,0.08)',
    loss: ['#5c4c1a', '#806b1a', '#a8891b', '#d0ab1d', '#f5cf2a'],
  },
  delta: {
    gain: '#1fa855',
    loss: '#f0503c',
    even: '#7d838c',
    gainRamp: ['#155f33', '#3fd17a'],
    lossRamp: ['#5c4c1a', '#f5cf2a'],
    gainSteps: ['#0f2418', '#133520', '#18482b'],
    lossSteps: ['#1c180c', '#2a2310', '#3b3114'],
  },
  phase: { braking: '#cf3550', turnIn: '#cc7c18', mid: '#9085e9', traction: '#199e70', throttle: '#3987e5' },
  tyre: { cold: '#2d9bf0', ok: '#18994a', hot: '#ff9a4d' },
  balance: { under: '#3d86ff', over: '#f0503c', neutral: '#3a3e45' },
  section: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  lap: { fastest: '#a64dff', clean: '#f2f3f5', outIn: '#7d838c', pit: '#a9aeb6', flag: '#f5cf2a' },
  event: { past: '#7d838c', current: '#1fa855', upcoming: '#3d86ff' },
  status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', none: '#8a8a86' },
  medal: { gold: '#d4af37', silver: '#c3c8d0', bronze: '#c08048' },
};

// Text on a filled colour: whichever of these two reads (constants/Theme.ts inkOn)
export const INK = { onLight: '#0b0c0e', onDark: '#ffffff' };

const Colors: Record<Scheme, Palette> = { light, dark };
export default Colors;
