// Every colour the app uses, by the job it does, for the light and the dark scheme. Screens never write a colour of
// their own: they take these tokens (useTheme() / themed() in constants/Theme.ts, or useThemeColor in Themed.tsx), so
// a change of look is a change of this file.
//
// The look is a race programme: off-white paper, black ink, rules always in ink, and colour only as flat square blocks
// and underlines. Light is the programme as printed (the default); Dark is the same programme inverted (near-black
// paper, off-white ink) with each accent re-stepped for the dark paper.
//
// Every categorical set below was checked with the chart palette validator against its own paper (light #F2EEE3, dark
// #141311): sector purple/green/yellow on all pairs, the five driving phases, understeer/oversteer, tyre cold/hot and the
// time-lost ramp in order. Colour never carries a meaning alone: every coloured mark keeps its label, sign or number.

export type Scheme = 'light' | 'dark';

export type Palette = {
  // Paper. There are no cards: `surface` is the paper too, so a box drawn with it is only its outline. `band` is a
  // darker sheet for inset blocks (out, in and pit laps, the masthead's date), `surfaceRaised` a pressed or picked row.
  background: string;
  surface: string;
  band: string;
  surfaceRaised: string;
  // Ink
  text: string;
  textSecondary: string;
  textMuted: string; // captions, placeholders, axis labels
  // Rules. `rule` is the ink rule of the programme (section rules, table heads); `border` and `separator` the faint
  // hairline between rows, under inputs and around what used to be a card.
  rule: string;
  border: string;
  borderStrong: string; // checkboxes, the outline of a control, the dashed outline of something not set
  separator: string;
  fill: string; // bar tracks, small tags, a drop target being hovered
  // The accent of an action: ink. A primary action is an ink block with paper text, a link is underlined ink.
  tint: string;
  onTint: string;
  tintSoft: string; // the wash behind a picked chip or row
  // The underline of the active page in the masthead, of the picked filter and of the main link: programme red
  mark: string;
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
  tyre: Record<TyreState, string> & { scale: string[]; onScale: string[] };
  balance: { under: string; over: string; neutral: string };
  section: string[]; // track-map sections, in order: the chip or card naming a section wears the same colour
  lap: Record<LapStatus, string>;
  event: Record<EventWhen, string>;
  status: { good: string; warning: string; serious: string; critical: string; none: string };
  medal: { gold: string; silver: string; bronze: string };
};

export type ChartTokens = {
  surface: string; // = Palette.surface: charts sit on the paper
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
  track: string; // the track drawn under a coloured line
  mid: string; // the neutral middle of a diverging scale (a cell with nothing to say)
};

// Section and lap times the motorsport way: purple the quickest of the event, green the quickest of this run, yellow
// slower; and the ramp of time lost, from a little to the most (drawn with an ink outline on the map and the bars).
export type TimingTokens = {
  best: string; // purple: fill of the event's best, white text on it
  personal: string; // green: fill of the run's best, white text on it
  slower: string; // yellow: the mark of a slower time
  slowerTint: string; // the fill behind a slower time, ink text on it
  onBest: string; // text on purple and green
  loss: string[]; // 5 steps, least time lost first
};

// Time against a reference: gains green, losses red, as text and flat blocks; `steps` grow with the size of the delta.
export type DeltaTokens = {
  gain: string;
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

// The programme as printed. The time-lost ramp's lightest step sits close to the paper on purpose (the mockup's
// pale pink): every mark drawn with it has an ink outline.
const light: Palette = {
  background: '#F2EEE3',
  surface: '#F2EEE3',
  band: '#E7E1D2',
  surfaceRaised: '#E7E1D2',
  text: '#111111',
  textSecondary: '#47433B',
  textMuted: '#7D776A',
  rule: '#111111',
  border: '#C5C1B6',
  borderStrong: '#111111',
  separator: '#C5C1B6',
  fill: '#E2DCCD',
  tint: '#111111',
  onTint: '#F2EEE3',
  tintSoft: '#E7E1D2',
  mark: '#E03A1E',
  error: '#C8361F',
  warning: '#8A6400',
  success: '#0E8A4A',
  tabBar: '#F2EEE3',
  tabIconDefault: '#7D776A',
  tabIconSelected: '#111111',

  chart: {
    surface: '#F2EEE3',
    ink: '#111111',
    ink2: '#47433B',
    muted: '#7D776A',
    grid: '#D3CEC1',
    axis: '#111111',
    other: '#B3AD9F',
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    seq: ['#cde2fb', '#184f95'],
    seq2: ['#fbe1d4', '#b4441a'],
    speed: ['#b7d3f6', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281', '#0d366b'],
    ideal: '#47433B',
    wash: 'rgba(42,120,214,0.08)',
    track: '#D3CEC1',
    mid: '#E2DCCD',
  },
  timing: {
    best: '#7B2FBE',
    personal: '#0B7F43',
    slower: '#D9A400',
    slowerTint: '#F1DE9A',
    onBest: '#FFFFFF',
    loss: ['#F4D3C9', '#EBA08B', '#E06A4F', '#C8361F', '#8F1D10'],
  },
  delta: {
    gain: '#0E8A4A',
    loss: '#E03A1E',
    even: '#7D776A',
    gainRamp: ['#9ED3B1', '#0E8A4A'],
    lossRamp: ['#F4D3C9', '#8F1D10'],
    gainSteps: ['#DCEBD9', '#BEDCC4', '#97C9A5'],
    lossSteps: ['#F4DCD3', '#EEC1B2', '#E7A28D'],
  },
  phase: { braking: '#D42A20', turnIn: '#EE8A12', mid: '#6B4FC8', traction: '#1291A8', throttle: '#2F8A2A' },
  // cold to hot around "in the window": strong blue, pale blue, paper grey, pale orange, strong orange; ink on the
  // pale steps, white on the strong ones
  tyre: { cold: '#1F5FBF', ok: '#0E8A4A', hot: '#C63F0B',
    scale: ['#1F5FBF', '#A9C6EC', '#E2DCCD', '#F6B888', '#C63F0B'],
    onScale: ['#FFFFFF', '#111111', '#111111', '#111111', '#FFFFFF'] },
  balance: { under: '#1F4FD1', over: '#D0186B', neutral: '#B3AD9F' },
  section: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  lap: { fastest: '#7B2FBE', clean: '#111111', outIn: '#7D776A', pit: '#47433B', flag: '#D9A400' },
  event: { past: '#7D776A', current: '#E03A1E', upcoming: '#111111' },
  status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', none: '#8a8a86' },
  medal: { gold: '#C99A06', silver: '#A9A79F', bronze: '#A8642A' },
};

// The programme inverted: near-black paper, off-white ink, each accent re-stepped to sit in the dark lightness band.
const dark: Palette = {
  background: '#141311',
  surface: '#141311',
  band: '#1F1D1A',
  surfaceRaised: '#262420',
  text: '#EDE8DC',
  textSecondary: '#BDB6A6',
  textMuted: '#8F8878',
  rule: '#EDE8DC',
  border: '#3F3C36',
  borderStrong: '#EDE8DC',
  separator: '#3F3C36',
  fill: '#2E2B26',
  tint: '#EDE8DC',
  onTint: '#141311',
  tintSoft: '#262420',
  mark: '#EE4A4A',
  error: '#EE4A4A',
  warning: '#E0B44A',
  success: '#2FB06A',
  tabBar: '#141311',
  tabIconDefault: '#8F8878',
  tabIconSelected: '#EDE8DC',

  chart: {
    surface: '#141311',
    ink: '#EDE8DC',
    ink2: '#BDB6A6',
    muted: '#8F8878',
    grid: '#34312C',
    axis: '#EDE8DC',
    other: '#56524A',
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    seq: ['#1c3554', '#86b6ef'],
    seq2: ['#4a2617', '#f08a5d'],
    speed: ['#184f95', '#256abf', '#3987e5', '#5598e7', '#86b6ef', '#9ec5f4', '#cde2fb'],
    ideal: '#BDB6A6',
    wash: 'rgba(57,135,229,0.12)',
    track: '#34312C',
    mid: '#2E2B26',
  },
  timing: {
    best: '#9A58EC',
    personal: '#167C46',
    slower: '#B48C16',
    slowerTint: '#463A12',
    onBest: '#FFFFFF',
    loss: ['#7E3222', '#A83A26', '#CF4A30', '#EE6A4C', '#FF9F84'],
  },
  delta: {
    gain: '#1E8F52',
    loss: '#EE4A4A',
    even: '#8F8878',
    gainRamp: ['#1A5A36', '#1E8F52'],
    lossRamp: ['#7E3222', '#FF9F84'],
    gainSteps: ['#16271C', '#1B3424', '#21442E'],
    lossSteps: ['#2C1A16', '#3D211B', '#522A21'],
  },
  phase: { braking: '#CF3550', turnIn: '#CC7C18', mid: '#9085E9', traction: '#1A98AE', throttle: '#46A040' },
  tyre: { cold: '#3F7FE0', ok: '#2AA862', hot: '#E0652A',
    scale: ['#3F7FE0', '#28466E', '#2E2B26', '#6E3F22', '#E0652A'],
    onScale: ['#FFFFFF', '#EDE8DC', '#EDE8DC', '#EDE8DC', '#FFFFFF'] },
  balance: { under: '#5B86F2', over: '#EC4A92', neutral: '#56524A' },
  section: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  lap: { fastest: '#9A58EC', clean: '#EDE8DC', outIn: '#8F8878', pit: '#BDB6A6', flag: '#B48C16' },
  event: { past: '#8F8878', current: '#EE4A4A', upcoming: '#EDE8DC' },
  status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', none: '#8a8a86' },
  medal: { gold: '#C99A06', silver: '#A9A79F', bronze: '#A8642A' },
};

// Text on a filled colour: whichever of these two reads (constants/Theme.ts inkOn)
export const INK = { onLight: '#111111', onDark: '#ffffff' };

const Colors: Record<Scheme, Palette> = { light, dark };
export default Colors;
