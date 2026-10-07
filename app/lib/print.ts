// Printing a page, or saving it as a PDF, in the browser: the Print button (components/PrintButton.tsx) opens the
// browser's own print dialog, which offers "Save as PDF" (Share › Print on an iPhone). While the page prints it is
// drawn Light on white paper, the masthead and the page's controls are left out, and every scrolling box is laid out
// in full: react-native-web's ScrollView is a box as tall as the window that scrolls inside, so the paper would
// otherwise show only the first screen. The same happens when the browser's own Print menu (Ctrl+P / Cmd+P) is used.
// Where the browser has no print dialog (the app added to an iPhone's home screen) the button makes the PDF itself,
// from the same paper page (lib/pdf.web.ts). iOS and Android apps have no Print button (nothing here runs there).
import { Platform } from 'react-native';

import Colors from '@/constants/Colors';
import { WIDE } from '@/constants/Theme';
import { setPrinting } from '@/lib/appearance';
import { flushSync } from '@/lib/flushSync';

/** True where a page can be printed: the web app, in a browser. */
export const canPrint = Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined'
  && typeof window.print === 'function';

/** Spread on a View or a Pressable to leave it off the printed page (`<View {...noPrint}>`): a control, a picker, a
 * form. On the web it becomes the element's data-print="hide"; on iOS and Android it is nothing. */
export const noPrint: object = Platform.OS === 'web' ? { dataSet: { print: 'hide' } } : {};

/** Spread on a View that must start on the same page as what follows it (a heading). */
export const printHead: object = Platform.OS === 'web' ? { dataSet: { print: 'head' } } : {};

/** Spread on a photo placed to fill its frame: on paper it fills the frame whatever its width there (a phone's page
 * is laid out wider on paper than on the screen it was measured on). */
export const printFill: object = Platform.OS === 'web' ? { dataSet: { print: 'fill' } } : {};

/** An iPhone or an iPad (an iPad says it is a Mac, but a Mac has no touch screen). */
export const onIos = canPrint && (/iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// attributes set on the page only while it prints
const FLOW = 'data-print-flow'; // a scrolling box, or a box holding one: laid out in full
const SIDE = 'data-print-side'; // a box that scrolls sideways (a wide table): shown whole
const KEEP = 'data-print-keep'; // a block small enough to stay on one page (a chart, a table row, a card)
const HIDE = 'data-print-off'; // the bar above a page with its name and the back arrow
const PAGE_WIDTH = 720; // CSS px across an A4 or Letter page inside its margins, roughly
const MAX_WIDTH = 1240; // the widest the page's body gets (components/Programme.tsx Page)

/** The paper's margin on every side, in mm (the @page rule below). */
export const PAPER_MARGIN_MM = 12;

// The paper page. These rules apply while the page prints, and to the copy of the page a PDF is drawn from.
const RULES = `
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  #root { display: block !important; height: auto !important; overflow: visible !important; }
  *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  [data-print="hide"], [${HIDE}] { display: none !important; }
  [${FLOW}] { flex: 0 0 auto !important; height: auto !important; min-height: 0 !important; max-height: none !important;
    overflow: visible !important; position: relative !important; top: auto !important; bottom: auto !important;
    transform: none !important; }
  [${SIDE}] { overflow: visible !important; }
  [${KEEP}], svg, img { break-inside: avoid; }
  [data-print="head"] { break-after: avoid; }
  [data-print="fill"] { left: 0 !important; top: 0 !important; width: 100% !important; height: 100% !important; }
  input, textarea { border-color: transparent !important; background: transparent !important; resize: none; }
  input::placeholder, textarea::placeholder { color: transparent !important; }
`;
const PRINT_CSS = `@page { margin: ${PAPER_MARGIN_MM}mm; }\n@media print {${RULES}}`;

let installed = false;
let printing = false;
let hold = false; // the page stays on paper whatever the browser's afterprint says (see printPage)
let title: string | null = null; // the PDF's name while the Print button prints
let saved: string | null = null; // the page's own title, put back after
let sheet: HTMLStyleElement | null = null; // the rules made for this page: its paper, its width
let white = ''; // the rule that makes the paper colour white, for the copy a PDF is drawn from

/** Put the print styles on the page and follow the browser's own Print menu. Once; the Print button calls it. */
export function installPrint() {
  if (!canPrint || installed) return;
  installed = true;
  const style = document.createElement('style');
  style.id = 'te-print';
  style.textContent = PRINT_CSS;
  document.head.appendChild(style);
  // the browser's Print menu: draw the page Light at once, then mark the boxes on the redrawn page
  window.addEventListener('beforeprint', () => {
    if (begin()) prepare();
  });
  window.addEventListener('afterprint', () => {
    if (!printing || hold) return;
    // Safari on an iPhone may say printing is over before its print sheet has laid the paper out
    if (onIos) untilTouch();
    else finish();
  });
}

/** Print the page (the browser's dialog, with Save as PDF), `name` as the PDF's file name. Called in the tap itself:
 * Safari opens its print sheet only for a tap, so the page is drawn Light and marked before print() is called. */
export function printPage(name: string) {
  if (!canPrint || printing) return;
  installPrint();
  title = name;
  begin();
  prepare();
  // Chrome and Firefox on a computer return from print() once their dialog is closed. Safari and the phones return at
  // once and lay the paper out after (again when the paper size is changed), and may say printing is over before they
  // have: the page stays on paper until the next touch or key on it (their dialog covers the page while it is open).
  hold = true;
  const opened = Date.now();
  window.print();
  if (!printing) return;
  if (Date.now() - opened > 1000) finish();
  else untilTouch();
}

/** Lay the page out as paper for the PDF lib/pdf.web.ts makes (Light, the boxes marked, the page's title as the PDF's
 * name): the width the page is laid out at on paper and the rules for the copy the PDF is drawn from. Null when the
 * page is being printed already. endPaper() puts the page back. */
export function paperPage(name: string): { width: number; css: string } | null {
  if (!canPrint || printing) return null;
  installPrint();
  title = name;
  hold = true; // the browser's afterprint has nothing to do with it
  begin();
  prepare();
  return { width: paperWidth(), css: RULES + white };
}

export function endPaper() {
  finish();
}

// until the next touch or key on the page
function untilTouch() {
  window.addEventListener('pointerdown', finish, { once: true, capture: true });
  window.addEventListener('keydown', finish, { once: true, capture: true });
}

function begin(): boolean {
  if (printing) return false;
  printing = true;
  flushSync(() => setPrinting(true)); // drawn Light now, so the page is measured and laid out on paper as it is drawn
  return true;
}

// The width the page is laid out at on paper: a phone's page as wide as the paper, a wide window as it is (up to the
// widest the page's body gets), scaled down to the paper's width
function paperWidth(): number {
  return window.innerWidth >= WIDE ? Math.min(window.innerWidth, MAX_WIDTH) : PAGE_WIDTH;
}

function prepare() {
  if (!printing) return;
  const root = document.getElementById('root');
  const wide = window.innerWidth >= WIDE;
  const width = paperWidth();
  // the stack's bar above a page (its name and the back arrow): the heading React Navigation marks level 1, and the
  // short boxes around it
  document.querySelectorAll('h1[aria-level="1"]').forEach((h) => {
    let bar: HTMLElement | null = null;
    for (let e = h.parentElement; e && e !== root && e.offsetHeight < 150; e = e.parentElement) bar = e;
    bar?.setAttribute(HIDE, '');
  });
  const divs = Array.from(document.body.getElementsByTagName('div'));
  for (const el of divs) {
    if (el.clientHeight === 0 && el.clientWidth === 0) continue;
    const cs = getComputedStyle(el);
    // every scrolling box, also one whose page fits the screen: left as it is, it shrank to nothing on paper (Seasons
    // with no season printed blank)
    if (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > 0) {
      for (let e: HTMLElement | null = el; e && e !== root && e !== document.body; e = e.parentElement) e.setAttribute(FLOW, '');
    } else if (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) {
      el.setAttribute(SIDE, '');
    }
  }
  // the biggest blocks shorter than about a third of a page stay whole on one page: a chart with its legend, a
  // card, a table row
  const keep = width * 0.45;
  for (const el of divs) {
    const h = el.offsetHeight;
    if (h === 0 || h > keep || el.hasAttribute(FLOW)) continue;
    const parent = el.parentElement;
    if (parent && (parent.offsetHeight > keep || parent.hasAttribute(FLOW))) el.setAttribute(KEEP, '');
  }
  sheet ??= document.head.appendChild(document.createElement('style'));
  white = whitePaper();
  sheet.textContent = `@media print { ${white} }\n` + (wide ? fit(width) : '');
  if (title) {
    saved ??= document.title;
    document.title = title;
  }
}

// A wide window prints as it is laid out on the screen (its charts measured the screen), scaled down to the paper's
// width: a zoom for each width the paper may have (A4 or Letter, upright or across, the margins picked).
function fit(width: number): string {
  const rules = [`@media print { #root { width: ${width}px !important; } }`];
  for (let w = 320; w < width; w += 8) {
    rules.push(`@media print and (min-width: ${w}px) { #root { zoom: ${(w / width).toFixed(4)} !important; } }`);
  }
  rules.push(`@media print and (min-width: ${width}px) { #root { zoom: 1 !important; } }`);
  return rules.join('\n');
}

// The Light paper is a warm off-white; on paper it is white. Every box drawn in the paper colour (a style rule of
// react-native-web or an inline style) prints white.
function whitePaper(): string {
  const hex = Colors.light.background.replace('#', '');
  const rgb = `rgb(${[0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  const selectors = [`[style*="background-color: ${rgb}"]`];
  const walk = (rules: CSSRuleList) => {
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule) {
        if (r.style.backgroundColor === rgb) selectors.push(r.selectorText);
      } else if ('cssRules' in r) {
        walk((r as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const s of Array.from(document.styleSheets)) {
    try {
      walk(s.cssRules);
    } catch {
      // a style sheet from another site (fonts): nothing of ours in it
    }
  }
  return `${selectors.join(', ')} { background-color: #fff !important; }`;
}

function finish() {
  window.removeEventListener('pointerdown', finish, { capture: true });
  window.removeEventListener('keydown', finish, { capture: true });
  if (!printing) return;
  printing = false;
  hold = false;
  for (const a of [FLOW, SIDE, KEEP, HIDE]) document.querySelectorAll(`[${a}]`).forEach((e) => e.removeAttribute(a));
  sheet?.remove();
  sheet = null;
  white = '';
  if (saved != null) document.title = saved;
  saved = null;
  title = null;
  setPrinting(false);
}
