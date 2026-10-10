// The race programme's page pieces, shared by every screen: the masthead with the text navigation, the photo hero
// with its huge headline and credit, the folio strip under it, numbered sections with their thick rule, very large
// figures with a coloured bar under them, text links with a heavy underline, flat colour blocks, legends, spec lines,
// the framed picture with its caption, and the colophon. Square edges, ink rules, colour only as flat blocks and
// underlines. Colours and faces come from constants/Colors.ts and constants/Theme.ts.
import { Href, Link, usePathname } from 'expo-router';
import { ReactNode, useState } from 'react';
import {
  Image,
  LayoutChangeEvent,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  ScrollViewProps,
  StyleSheet,
  TextStyle,
  useWindowDimensions,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { Text, View } from '@/components/Themed';
import { Fonts, Focus, Photo, Space, TAP, tapRoom, themed, Type, useTheme, WIDE } from '@/constants/Theme';
import { BackLink, noteVisit } from '@/components/Back';
import { useKnownMode } from '@/lib/eventModes';
import { noPrint, printFill, printHead } from '@/lib/print';
import { a11yState } from '@/lib/a11yState';

/** True on a wide screen (desktop, tablet): pages take their multi-column layout. */
export function useWide() {
  return useWindowDimensions().width >= WIDE;
}

/** The side margin of the page. */
export function useGutter() {
  return useWide() ? Space.gutter : Space.gutterPhone;
}

// ---------- masthead ----------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const today = () => {
  const d = new Date();
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

// The app's activities (Gabriele, 2026-10-07): race weekends, coaching days, the drivers (fingerprints and habits),
// then uploading and the tools. Seasons sit on the Weekend list and under Tools; a debrief is recorded from the
// weekend page and from each run. Setup (2026-10-08) is a tool of its own, away from the reports.
type NavKey = 'weekend' | 'coaching' | 'drivers' | 'setup' | 'upload' | 'tools';
const NAV: { key: NavKey; label: string; href: Href }[] = [
  { key: 'weekend', label: 'Weekend', href: '/' },
  { key: 'coaching', label: 'Coaching', href: '/coaching' },
  { key: 'drivers', label: 'Drivers', href: '/drivers' },
  { key: 'setup', label: 'Setup', href: '/setup' },
  { key: 'upload', label: 'Upload', href: '/upload' },
  { key: 'tools', label: 'Tools', href: '/tools' },
];

/** Which part of the app a page belongs to: its masthead link is underlined. An event's page is a coaching day's
 * when `coaching` says so (the event's mode, lib/eventModes.ts). The manual belongs to none. */
export function navOf(pathname: string, coaching = false): NavKey | null {
  if (pathname.startsWith('/manual')) return null;
  if (pathname.startsWith('/coaching') || (coaching && pathname.startsWith('/event/'))) return 'coaching';
  if (pathname.startsWith('/drivers')) return 'drivers';
  if (pathname === '/setup') return 'setup';
  if (pathname.startsWith('/upload')) return 'upload';
  if (pathname.startsWith('/tools') || pathname.startsWith('/garage') || pathname.startsWith('/seasons')) return 'tools';
  return 'weekend';
}


/** The paper masthead at the top of every page: Back (on every page but the race weekends, components/Back.tsx), the
 * nameplate and today's date, the parts of the app as text links (the one you are in underlined in red) and the
 * Manual (app/manual.tsx), then a thick and a thin rule. On a phone the links take a row of their own under the
 * nameplate, and the Manual the date's place beside it. */
export function Masthead() {
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const insets = useSafeAreaInsets();
  const path = usePathname();
  // the trail Back reads: every page shown, in order
  noteVisit(path);
  // on a phone the manual takes the date's place: one tap from every page (Gabriele, 2026-10-10: "Can you add a
  // 'user manual' with all functions explained and where to find them? Add it in the app")
  const date = wide ? <Text style={styles.issue}>{today()}</Text> : null;
  const manual = (
    <Link href="/manual" asChild>
      <Pressable accessibilityRole="link" accessibilityLabel="Manual: every function and where to find it"
        {...a11yState({ selected: path.startsWith('/manual') }, 'link')} hitSlop={6}
        style={StyleSheet.flatten([styles.navItem, path.startsWith('/manual') && styles.navOn])}>
        <Text style={StyleSheet.flatten([wide ? styles.navText : styles.navTextPhone, styles.manualText])}>Manual</Text>
      </Pressable>
    </Link>
  );
  const event = /^\/event\/(\d+)/.exec(path);
  const on = navOf(path, useKnownMode(event ? Number(event[1]) : null) === 'coaching');
  const nav = (
    <View style={wide ? styles.nav : styles.navPhone} accessibilityRole="tablist">
      {NAV.map((n) => (
        // Link asChild hands its child's style to a web anchor, which can't take a style array: one object. On the
        // web it is a link, so the page it is on says so as a link does (aria-current)
        <Link key={n.key} href={n.href} asChild>
          <Pressable accessibilityRole="tab" {...a11yState({ selected: n.key === on }, 'link')} hitSlop={6}
            style={StyleSheet.flatten([styles.navItem, n.key === on && styles.navOn])}>
            <Text style={wide ? styles.navText : styles.navTextPhone}>{n.label}</Text>
          </Pressable>
        </Link>
      ))}
    </View>
  );
  return (
    // the menu stays off the printed page
    <View style={StyleSheet.flatten([styles.masthead, { paddingTop: insets.top + (wide ? 14 : 10),
      paddingHorizontal: wide ? Space.gutter : Space.gutterPhone }])} {...noPrint}>
      {wide ? (
        <View style={styles.mastRow}>
          <View style={styles.nameplate}>
            <BackLink path={path} />
            <Link href="/" asChild>
              <Pressable accessibilityRole="link" accessibilityLabel="The Engineer: race weekends" style={styles.home}>
                <Text style={styles.mark}>The Engineer</Text>
              </Pressable>
            </Link>
            {date}
          </View>
          <View style={styles.navSide}>
            {nav}
            {manual}
          </View>
        </View>
      ) : (
        <>
          <View style={styles.nameplatePhone}>
            <View style={styles.nameplate}>
              <BackLink path={path} />
              <Link href="/" asChild>
                <Pressable accessibilityRole="link" accessibilityLabel="The Engineer: race weekends"
                  style={styles.homePhone}>
                  <Text style={styles.markPhone}>The Engineer</Text>
                </Pressable>
              </Link>
            </View>
            {manual}
          </View>
          {nav}
        </>
      )}
      <DoubleRule />
    </View>
  );
}

/** The programme's double rule: a thick ink rule, a gap, a thin one. */
export function DoubleRule() {
  const styles = useStyles();
  return (
    <View>
      <View style={styles.ruleThick} />
      <View style={styles.ruleGap} />
      <View style={styles.ruleThin} />
    </View>
  );
}

/** An ink rule across the page: `weight` 1 (thin), 3 or 6 (a section's). */
export function Rule({ weight = 1, style }: { weight?: number; style?: ViewStyle }) {
  const theme = useTheme();
  return <View style={StyleSheet.flatten([{ height: weight, backgroundColor: theme.rule }, style])} />;
}

// ---------- photos ----------

/** A photo filling its frame, cropped around `focus` (0 to 1 across and down, like CSS object-position), on any
 * platform: it is laid out at the frame's size, then placed. */
export function PhotoFill({ photo, focus, style }: { photo: Photo; focus?: Focus; style?: ViewStyle }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const f = focus ?? photo.focus;
  let img: ViewStyle | null = null;
  if (box) {
    const scale = Math.max(box.w / photo.width, box.h / photo.height);
    const w = photo.width * scale;
    const h = photo.height * scale;
    img = { position: 'absolute', width: w, height: h, left: (box.w - w) * f.x, top: (box.h - h) * f.y };
  }
  return (
    <View style={StyleSheet.flatten([{ overflow: 'hidden' }, style])} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {img && <Image source={photo.source} style={img as object} resizeMode="cover" accessibilityIgnoresInvertColors
        {...printFill} />}
    </View>
  );
}

const openLink = (url: string) => {
  if (Platform.OS === 'web') window.open(url, '_blank', 'noopener');
  else Linking.openURL(url);
};

/** A photo's credit, tappable: it opens the photo's page with its author and licence. `style` places the tappable
 * box (at least a tap target), `box` is what shows (the credit's own background). */
export function Credit({ photo, style, box, textStyle }: { photo: Photo; style?: ViewStyle; box?: ViewStyle;
  textStyle?: TextStyle }) {
  const styles = useStyles();
  return (
    <Pressable onPress={() => openLink(photo.link)} accessibilityRole="link"
      accessibilityLabel={`${photo.credit}: open the photo's page`} style={StyleSheet.flatten([styles.creditHit, style])}>
      <View style={box}><Text style={textStyle}>{photo.credit}</Text></View>
    </Pressable>
  );
}

/** The full-bleed photo at the top of a page: the photo, a dark gradient only behind the headline, the credit in the top
 * right corner, then the kicker (a red tag and the rest, which can link back up), the huge headline and an italic deck.
 * Every word on the photo sits on a dark scrim (the gradient, or its own dark box), so it reads whatever the photo. */
export function Hero({ photo, tag, rest, restHref, title, deck, height, deckGap, badge }: {
  photo: Photo;
  tag: string;
  rest?: string;
  restHref?: Href;
  title: string;
  deck?: string;
  height?: number;
  deckGap?: number; // room between the headline and the deck: more under a name with an underscore (06_D2S1)
  badge?: ReactNode; // set first in the kicker: an event's country (components/Flag.tsx HeroCountry)
}) {
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const gutter = wide ? Space.gutter : Space.gutterPhone;
  const h = height ?? (wide ? 420 : 440);
  // 116 px on a desktop and 66 on a phone, smaller when the longest word would not fit across (Anton's capitals are
  // about 0.46 of their size wide); the headline wraps between words
  const longest = Math.max(...title.split(/\s+/).map((w) => w.length), 1);
  const fit = (Math.min(width, 1240) - 2 * gutter) / (longest * 0.47);
  const size = Math.max(36, Math.floor(Math.min(wide ? 116 : 66, fit)));
  const restText = rest ? <Text style={styles.kickRestText} numberOfLines={1}>{rest}</Text> : null;
  // The shade: from SHADE_FADE px above the words to the photo's foot, and never shorter than the lower half or two
  // thirds of the photo. Behind every word it is at least SCRIM_UNDER_WORDS dark, so even a white photo leaves the
  // headline and the deck their contrast; a low photo (the race weekend's) or a long headline can't rise above it.
  const [copyH, setCopyH] = useState(0);
  const bottom = wide ? 26 : 18;
  const words = copyH + bottom;
  const shadeH = Math.min(h, Math.max(h * (wide ? 0.56 : 0.66), words + SHADE_FADE));
  const wordsAt = copyH ? Math.max(0, 1 - words / shadeH) : 0.3; // where the words start in the shade
  return (
    <View style={StyleSheet.flatten([styles.hero, { height: h }])}>
      <PhotoFill photo={photo} focus={wide ? photo.focus : photo.focusPhone ?? photo.focus} style={StyleSheet.absoluteFill as ViewStyle} />
      <View pointerEvents="none" style={StyleSheet.flatten([styles.shade, { height: shadeH }])}>
        <Svg width="100%" height="100%" preserveAspectRatio="none">
          <Defs>
            <LinearGradient id="heroShade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={SCRIM} stopOpacity={0} />
              <Stop offset={wordsAt} stopColor={SCRIM} stopOpacity={copyH ? SCRIM_UNDER_WORDS : 0.5} />
              <Stop offset="1" stopColor={SCRIM} stopOpacity={0.88} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#heroShade)" />
        </Svg>
      </View>
      <Credit photo={photo} style={StyleSheet.flatten([styles.credit, wide ? null : styles.creditPhone])}
        box={styles.creditBox} textStyle={styles.creditText} />
      <View onLayout={(e) => setCopyH(e.nativeEvent.layout.height)}
        style={StyleSheet.flatten([styles.copy, { left: gutter, right: gutter, bottom }])}>
        <View style={styles.kicker}>
          {badge}
          <View style={styles.kickTag}><Text style={styles.kickTagText}>{tag}</Text></View>
          {rest && restHref ? (
            <Link href={restHref} asChild>
              <Pressable accessibilityRole="link" style={styles.kickHit}>
                <View style={styles.kickRest}>{restText}</View>
              </Pressable>
            </Link>
          ) : rest ? <View style={styles.kickRest}>{restText}</View> : null}
        </View>
        <Text style={StyleSheet.flatten([styles.headline, { fontSize: size, lineHeight: size * 0.92 }])}
          accessibilityRole="header">{title}</Text>
        {deck ? <Text style={StyleSheet.flatten([wide ? styles.deck : styles.deckPhone, deckGap != null && { marginTop: deckGap }])}>
          {deck}</Text> : null}
      </View>
    </View>
  );
}

/** The strip of facts under a hero, split by thin rules (a column on a phone). */
export function Folio({ items }: { items: ReactNode[] }) {
  const styles = useStyles();
  const wide = useWide();
  const shown = items.filter((i) => i != null && i !== false && i !== '');
  return (
    <View style={StyleSheet.flatten([wide ? styles.folio : styles.folioPhone,
      { paddingHorizontal: wide ? Space.gutter : Space.gutterPhone }])}>
      {shown.map((it, i) => (
        <View key={i} style={StyleSheet.flatten([wide ? styles.folioItem : styles.folioItemPhone,
          i === shown.length - 1 && styles.folioLast])}>
          <Text style={wide ? styles.folioText : styles.folioTextPhone}>{it}</Text>
        </View>
      ))}
    </View>
  );
}

/** Bold inside a folio or a label. */
export function B({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.bold}>{children}</Text>;
}

// ---------- page and sections ----------

/** A page that scrolls: the paper, the page's own content at full width (a hero), then `children` inside the gutter. */
export function Page({ top, children, scrollRef, ...rest }: ScrollViewProps & {
  top?: ReactNode; // full-bleed pieces above the page body (the hero and its folio)
  children: ReactNode;
  scrollRef?: React.Ref<ScrollView>;
}) {
  const styles = useStyles();
  const gutter = useGutter();
  return (
    <ScrollView ref={scrollRef} style={styles.screen} contentContainerStyle={styles.scroll} {...rest}>
      {top}
      <View style={StyleSheet.flatten([styles.body, { paddingHorizontal: gutter }])}>{children}</View>
    </ScrollView>
  );
}

/** A numbered section: the thick rule, the number in an ink block, the headline and its italic line, then the content.
 * `print={false}`: left off a printed page (a form). */
export function Section({ no, title, dek, children, style, onLayout, print }: {
  no: number | string;
  title: string;
  dek?: string;
  children?: ReactNode;
  style?: ViewStyle;
  onLayout?: (e: LayoutChangeEvent) => void;
  print?: boolean;
}) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={StyleSheet.flatten([wide ? styles.section : styles.sectionPhone, style])} onLayout={onLayout}
      {...(print === false ? noPrint : null)}>
      {/* on paper the headline starts on the same page as what it heads */}
      <View style={styles.secRule} {...printHead} />
      <View style={wide ? styles.secHead : styles.secHeadPhone} {...printHead}>
        <View style={styles.secNo}><Text style={styles.secNoText}>{typeof no === 'number' ? String(no).padStart(2, '0') : no}</Text></View>
        <View style={styles.secWords}>
          <Text style={wide ? styles.secTitle : styles.secTitlePhone} accessibilityRole="header">{title}</Text>
          {dek ? <Text style={wide ? styles.secDek : styles.secDekPhone}>{dek}</Text> : null}
        </View>
      </View>
      {children}
    </View>
  );
}

/** A label in Archivo Narrow capitals; `muted` in the caption grey. */
export function Label({ children, muted, small, style }: { children: ReactNode; muted?: boolean; small?: boolean;
  style?: TextStyle }) {
  const styles = useStyles();
  return <Text style={StyleSheet.flatten([styles.label, small && styles.labelSmall, muted && styles.muted, style])}>{children}</Text>;
}

// A figure stays on one line: shrunk to fit on iOS and Android; on the web (which can't shrink it) it is never cut
// short with an ellipsis, so give it the room.
const FIG_LINES = Platform.OS === 'web' ? undefined : 1;

/** A very large figure: its label, the number in Anton (with a small unit), a coloured bar under it and an italic
 * note. */
export function Fig({ label, value, unit, size = 64, color, bar, barHeight = 8, note, style }: {
  label?: string;
  value: string;
  unit?: string;
  size?: number;
  color?: string;
  bar?: string; // the bar's colour; none without
  barHeight?: number;
  note?: string;
  style?: ViewStyle;
}) {
  const styles = useStyles();
  return (
    <View style={style}>
      {label ? <Text style={styles.figLabel}>{label}</Text> : null}
      <Text style={StyleSheet.flatten([styles.fig, { fontSize: size, lineHeight: size * 1.02 }, color ? { color } : null])}
        numberOfLines={FIG_LINES} adjustsFontSizeToFit>
        {value}
        {unit ? <Text style={StyleSheet.flatten([styles.figUnit, { fontSize: Math.round(size * 0.42), lineHeight: Math.round(size * 0.46) },
          color ? { color } : null])}>
          {` ${unit}`}</Text> : null}
      </Text>
      {bar ? <View style={{ height: barHeight, backgroundColor: bar, marginTop: 10 }} /> : null}
      {note ? <Text style={styles.figNote}>{note}</Text> : null}
    </View>
  );
}

/** A text link: Archivo Narrow capitals over a heavy underline (red for the main one), with an arrow when it goes
 * somewhere. Give it an `href`, or an `onPress` for an action on the page. Left off a printed page unless `print`
 * (a link that names something the page is about). */
export function TextLink({ label, href, onPress, red, arrow, small, disabled, print }: {
  label: string;
  href?: Href;
  onPress?: () => void;
  red?: boolean;
  arrow?: boolean;
  small?: boolean;
  disabled?: boolean;
  print?: boolean;
}) {
  const styles = useStyles();
  // the pressable box is a full tap target around the underlined word, without moving it (constants/Theme.ts tapRoom)
  const body = (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole={href ? 'link' : 'button'}
      {...(print ? null : noPrint)} style={StyleSheet.flatten([styles.tlinkHit, disabled && styles.dim])}>
      <View style={StyleSheet.flatten([styles.tlink, red && styles.tlinkRed])}>
        <Text style={small ? styles.tlinkTextSmall : styles.tlinkText}>{label}{arrow ? ' →' : ''}</Text>
      </View>
    </Pressable>
  );
  // Link asChild hands its child's style to a web anchor, which can't take a style array: one object (flattened above)
  return href ? <Link href={href} asChild>{body}</Link> : body;
}

/** A flat block of colour with a word on it (GOLD, FASTEST, PIT, Q...). */
export function Block({ label, color, ink, size = 13, style }: { label: string; color: string; ink: string;
  size?: number; style?: ViewStyle }) {
  const styles = useStyles();
  return (
    <View style={StyleSheet.flatten([styles.block, { backgroundColor: color }, style])}>
      <Text style={StyleSheet.flatten([styles.blockText, { color: ink, fontSize: size }])}>{label}</Text>
    </View>
  );
}

/** A legend entry: a flat swatch and its name. */
export function Swatch({ color, label, width = 18, height = 12, outline }: { color: string; label?: string; width?: number;
  height?: number; outline?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.legendItem}>
      <View style={{ width, height, backgroundColor: color, borderWidth: outline ? 1 : 0, borderColor: outline }} />
      {label ? <Text style={styles.legendText}>{label}</Text> : null}
    </View>
  );
}

/** A spec line: a label on the left, its value on the right, over a faint rule. */
export function SpecLine({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.spec}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.specValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

/** A framed picture with its credit as the caption under it. */
export function InsetPhoto({ photo, height, style }: { photo: Photo; height: number; style?: ViewStyle }) {
  const styles = useStyles();
  return (
    <View style={StyleSheet.flatten([styles.inset, style])}>
      <PhotoFill photo={photo} style={{ height }} />
      <Credit photo={photo} style={styles.caption} textStyle={styles.captionText} />
    </View>
  );
}

/** The page's closing line: a thick rule, the page's name on the left and, on the right, where it is or `links` to
 * the pages next to it. */
export function Colophon({ left, right, links }: { left: string; right?: string;
  links?: { label: string; href: Href }[] }) {
  const styles = useStyles();
  return (
    <View style={styles.colophon}>
      <Text style={styles.label}>{left}</Text>
      {right ? <Text style={StyleSheet.flatten([styles.label, styles.muted])}>{right}</Text> : null}
      {links ? (
        <View style={styles.colLinks}>
          {links.map((l, i) => (
            <View key={l.label} style={styles.colLink}>
              {i > 0 && <Text style={StyleSheet.flatten([styles.label, styles.muted])}>·</Text>}
              <Link href={l.href} asChild>
                <Pressable accessibilityRole="link" style={styles.colHit}>
                  <Text style={StyleSheet.flatten([styles.label, styles.muted])}>{l.label}</Text>
                </Pressable>
              </Link>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const PHOTO_INK = '#F7F4EC'; // text on a photo, in both schemes
// the photo's scrim: the near-black every word on a photo sits on (the hero's shade, the kicker's and the credit's boxes)
const SCRIM = '#0a0a0a';
const scrim = (a: number) => `rgba(10,10,10,${a})`;
// the hero's shade behind its words, at the least: a white photo under it is then rgb(103,103,103), which gives the
// headline 5:1 and the deck 4.7:1
const SCRIM_UNDER_WORDS = 0.62;
const SHADE_FADE = 44; // the shade's fade from clear, above the words

const useStyles = themed((c) => ({
  // masthead
  masthead: { backgroundColor: c.background },
  mastRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingBottom: 10, gap: 16 },
  nameplate: { flexDirection: 'row', alignItems: 'baseline', gap: 14, flexShrink: 1 },
  nameplatePhone: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingBottom: 8 },
  mark: { fontFamily: Fonts.display, fontSize: 34, lineHeight: 38, textTransform: 'uppercase', color: c.text },
  markPhone: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 32, textTransform: 'uppercase', color: c.text },
  issue: { ...Type.label, fontSize: 13, color: c.textSecondary },
  // the nameplate's link, a full tap target (it is 32 to 38 px tall as drawn)
  home: tapRoom(6),
  homePhone: tapRoom(6),
  nav: { flexDirection: 'row', gap: 28 },
  navSide: { flexDirection: 'row', alignItems: 'flex-end', gap: 28, borderLeftWidth: 0 },
  manualText: { color: c.textSecondary },
  // on the smallest phones (320 px) the six links wrap rather than run off the side; the row gap clears a link's tap
  // room above its word (navItem)
  navPhone: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 20,
    borderTopWidth: 1, borderColor: c.rule, paddingTop: 8, paddingBottom: 6 },
  // a full tap target: the room is above the word, the red underline stays under it
  navItem: { paddingBottom: 4, borderBottomWidth: 4, borderColor: 'transparent', paddingTop: 19, marginTop: -19, minWidth: TAP },
  navOn: { borderColor: c.mark },
  navText: { ...Type.label, fontSize: 14, letterSpacing: 2, color: c.text },
  navTextPhone: { ...Type.label, fontSize: 13, letterSpacing: 1.6, color: c.text },
  ruleThick: { height: 6, backgroundColor: c.rule },
  ruleGap: { height: 3 },
  ruleThin: { height: 1, backgroundColor: c.rule },

  // hero
  hero: { position: 'relative', overflow: 'hidden', backgroundColor: '#2a2a28' },
  shade: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  creditHit: { minHeight: TAP, minWidth: TAP, justifyContent: 'center' },
  credit: { position: 'absolute', right: 0, top: 0, maxWidth: '70%', padding: 10, justifyContent: 'flex-start',
    alignItems: 'flex-end' },
  creditPhone: { maxWidth: '62%' },
  creditBox: { backgroundColor: scrim(0.72), paddingHorizontal: 6, paddingVertical: 2 },
  creditText: { fontFamily: Fonts.label, fontSize: 12, letterSpacing: 0.6, color: PHOTO_INK, textAlign: 'right' },
  copy: { position: 'absolute' },
  kicker: { flexDirection: 'row', alignItems: 'stretch', marginBottom: 12, flexWrap: 'wrap' },
  kickTag: { backgroundColor: c.mark, paddingHorizontal: 9, paddingTop: 5, paddingBottom: 4, justifyContent: 'center' },
  kickTagText: { ...Type.label, fontSize: 13, letterSpacing: 1.7, color: '#ffffff' },
  // its own dark scrim: the photo behind it can be anything
  kickRest: { borderWidth: 1, borderLeftWidth: 0, borderColor: 'rgba(247,244,236,0.85)', paddingHorizontal: 10, paddingTop: 5,
    paddingBottom: 4, justifyContent: 'center', flexShrink: 1, backgroundColor: scrim(0.6) },
  // the link back up: a full tap target around its box, which stays as drawn
  kickHit: { flexShrink: 1, ...tapRoom(8) },
  kickRestText: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, letterSpacing: 1.7, color: PHOTO_INK },
  headline: { fontFamily: Fonts.display, textTransform: 'uppercase', color: PHOTO_INK, textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowRadius: 18, textShadowOffset: { width: 0, height: 1 } },
  deck: { fontFamily: Type.dek.fontFamily, fontSize: 19, lineHeight: 26, color: '#EFEBE0', marginTop: 10, maxWidth: 640,
    textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },
  deckPhone: { fontFamily: Type.dek.fontFamily, fontSize: 16, lineHeight: 22, color: '#EFEBE0', marginTop: 10,
    textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 },

  // folio
  folio: { flexDirection: 'row', flexWrap: 'wrap', borderBottomWidth: 1, borderColor: c.rule },
  folioPhone: { flexDirection: 'column', borderBottomWidth: 1, borderColor: c.rule },
  folioItem: { paddingTop: 11, paddingBottom: 10, paddingRight: 18, marginRight: 18, borderRightWidth: 1, borderColor: c.rule },
  folioItemPhone: { paddingTop: 7, paddingBottom: 6, borderBottomWidth: 1, borderColor: c.separator },
  folioLast: { borderRightWidth: 0, borderBottomWidth: 0, marginRight: 0 },
  folioText: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, letterSpacing: 1.2, color: c.text },
  folioTextPhone: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, letterSpacing: 1.1, color: c.text },
  bold: { fontFamily: Type.label.fontFamily },

  // page
  screen: { flex: 1, backgroundColor: c.background },
  scroll: { paddingBottom: 56 },
  body: { width: '100%', maxWidth: 1240, alignSelf: 'center' },
  section: { marginTop: 44 },
  sectionPhone: { marginTop: 34 },
  secRule: { height: 6, backgroundColor: c.rule },
  secHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 20, paddingTop: 10, marginBottom: 22 },
  secHeadPhone: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingTop: 10, marginBottom: 16 },
  secNo: { backgroundColor: c.rule, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 5 },
  secNoText: { fontFamily: Fonts.display, fontSize: 22, lineHeight: 24, letterSpacing: 0.9, color: c.background },
  secWords: { flex: 1, minWidth: 0 },
  secTitle: { fontFamily: Fonts.display, fontSize: 44, lineHeight: 46, textTransform: 'uppercase', color: c.text },
  secTitlePhone: { fontFamily: Fonts.display, fontSize: 34, lineHeight: 36, textTransform: 'uppercase', color: c.text },
  secDek: { fontFamily: Type.dek.fontFamily, fontSize: 17, lineHeight: 24, color: c.textSecondary, marginTop: 6, maxWidth: 640 },
  secDekPhone: { fontFamily: Type.dek.fontFamily, fontSize: 16, lineHeight: 22, color: c.textSecondary, marginTop: 6 },

  // type
  label: { ...Type.label, fontFamily: Fonts.label, color: c.text },
  labelSmall: { fontSize: 13, letterSpacing: 1 },
  muted: { color: c.textMuted },
  dim: { opacity: 0.45 },
  figLabel: { ...Type.label, fontSize: 13, letterSpacing: 1.4, marginBottom: 8, color: c.text },
  fig: { fontFamily: Fonts.display, color: c.text, letterSpacing: 0.2 },
  figUnit: { fontFamily: Fonts.display, letterSpacing: 0.4, color: c.text },
  figNote: { fontFamily: Type.dek.fontFamily, fontSize: 16, lineHeight: 22, color: c.textSecondary, marginTop: 8 },

  // links and blocks
  // the word is 21 px tall with its underline: 12 px of room above and below make it a 44 px tap target
  tlinkHit: { alignSelf: 'flex-start', minWidth: TAP, ...tapRoom(12) },
  tlink: { alignSelf: 'flex-start', borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 1 },
  tlinkRed: { borderColor: c.mark },
  tlinkText: { ...Type.link, lineHeight: 18, color: c.text },
  tlinkTextSmall: { ...Type.link, fontSize: 13, lineHeight: 17, letterSpacing: 1.2, color: c.text },
  block: { alignSelf: 'flex-start', paddingHorizontal: 7, paddingTop: 2, paddingBottom: 1 },
  blockText: { ...Type.label, fontFamily: face700(), letterSpacing: 1.2 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  legendText: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, letterSpacing: 0.7, color: c.text },
  spec: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, borderBottomWidth: 1,
    borderColor: c.separator, paddingTop: 8, paddingBottom: 7 },
  specValue: { fontFamily: face700(), fontSize: 15, textAlign: 'right', flexShrink: 1, color: c.text },

  // inset photo
  inset: { borderWidth: 2, borderColor: c.rule, backgroundColor: c.rule },
  // 12 px of room above and below (over the photo, past the frame) make the credit a tap target, as drawn
  caption: { paddingHorizontal: 6, paddingTop: 16, paddingBottom: 15, marginVertical: -12 },
  captionText: { fontFamily: Fonts.label, fontSize: 12, letterSpacing: 0.4, color: c.background },

  colophon: { marginTop: 40, borderTopWidth: 6, borderColor: c.rule, paddingTop: 10, flexDirection: 'row', flexWrap: 'wrap',
    justifyContent: 'space-between', gap: 8 },
  colLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, maxWidth: '100%' }, // wraps, never past the edge
  colLink: { flexDirection: 'row', gap: 6 },
  colHit: { minWidth: TAP, ...tapRoom(14) },
}));

function face700() {
  return Type.label.fontFamily as string;
}
