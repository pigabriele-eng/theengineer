// The PDF of a page, made in the browser, for the app added to an iPhone's or iPad's home screen: Safari opens no
// print dialog there (window.print() does nothing), so the Print button (components/PrintButton.tsx) makes the PDF
// itself and hands it to the phone's share sheet (Save to Files, Print, Mail, AirDrop...), or downloads it where files
// can't be shared.
//
// The page is laid out on paper as it prints (lib/print.ts: Light on white, the masthead and the controls left out,
// every scrolling box in full, as wide as A4 paper), copied and drawn into pictures by html2canvas-pro (loaded only
// when a PDF is made, so no page loads slower), a few pages at a time: an iPhone allows about 16.7 million pixels a
// canvas and only so much canvas memory in all, so each picture stays well under that and is freed once its pages are
// cut out. Pages break between lines, charts and photos, as the printed page does, and go into an A4 PDF
// (lib/pdfFile.ts) named like the printed one. lib/pdf.ts is the same module on iOS and Android, where nothing prints.
import { useSyncExternalStore } from 'react';

import { A4_PT, PdfPicture, pdfOfPictures } from '@/lib/pdfFile';
import { endPaper, onIos, PAPER_MARGIN_MM, paperPage } from '@/lib/print';

type Html2Canvas = typeof import('html2canvas-pro').default;
type Options = NonNullable<Parameters<Html2Canvas>[1]>;

const standalone = typeof navigator !== 'undefined'
  && ((navigator as Navigator & { standalone?: boolean }).standalone === true
    || (onIos && typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches));

/** True where the Print button makes the PDF itself: the app opened from an iPhone's or iPad's home screen. */
export const pdfInstead = standalone;

/** The PDF the Print button is making, for the note it shows (`owner`: the button that was tapped). */
export type PdfState =
  | { step: 'idle' }
  | { step: 'making'; owner: string }
  | { step: 'ready'; owner: string; file: File } // made; the share sheet wants a tap of its own
  | { step: 'failed'; owner: string; message: string };

const IDLE: PdfState = { step: 'idle' };
let state: PdfState = IDLE;
const listeners = new Set<() => void>();
const set = (next: PdfState) => {
  state = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const current = () => state;

export function usePdfState(): PdfState {
  return useSyncExternalStore(subscribe, current, current);
}

// Why the PDF couldn't be made, in words for the note (any other failure is put plainly there, its details in the
// console)
const plain = (words: string) => Object.assign(new Error(words), { plain: true });

/** Make the page's PDF named `name` and hand it on; `owner` is the button tapped, which shows the note. */
export function makePdf(name: string, owner: string) {
  if (state.step === 'making') return;
  set({ step: 'making', owner });
  void (async () => {
    try {
      await drawn(); // the note first
      const file = await makeFile(name);
      await handOn(file, owner, false);
    } catch (e) {
      const words = (e as { plain?: boolean })?.plain ? (e as Error).message : null;
      if (!words) console.warn('The PDF could not be made', e);
      set({ step: 'failed', owner, message: words ?? 'Something went wrong while drawing the page.' });
    }
  })();
}

/** The note's Share button: the share sheet, in a tap of its own. */
export function sharePdf() {
  if (state.step === 'ready') void handOn(state.file, state.owner, true);
}

export function closePdf() {
  if (state.step !== 'making') set(IDLE);
}

// To the share sheet, else a download. Safari opens the share sheet only within a few seconds of a tap: when the PDF
// took longer, the note asks for a tap on its Share button.
async function handOn(file: File, owner: string, tapped: boolean) {
  const data: ShareData = { files: [file], title: file.name.replace(/\.pdf$/, '') };
  if (typeof navigator.share === 'function' && navigator.canShare?.(data)) {
    set({ step: 'ready', owner, file });
    try {
      await navigator.share(data);
      set(IDLE);
    } catch (e) {
      const why = (e as Error)?.name;
      if (why === 'AbortError') set(IDLE); // the share sheet was closed
      else if (why === 'NotAllowedError' && !tapped) set({ step: 'ready', owner, file });
      else {
        download(file);
        set(IDLE);
      }
    }
    return;
  }
  download(file);
  set(IDLE);
}

function download(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const drawn = () => new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done, 0)));

// ---------- the pictures ----------

const BUDGET = 8_000_000; // pixels in one picture: half of what an iPhone allows a canvas
const QUALITY = 0.92; // of each page's JPEG
const HEAD_ROOM = 48; // CSS px under a heading that stay on its page with it

async function makeFile(name: string): Promise<File> {
  const paper = paperPage(name);
  if (!paper) throw plain('The page is being printed already.');
  let boxes: Element[] = [];
  try {
    const lib = import('html2canvas-pro').catch(() => { // fetched while the boxes are numbered
      throw plain("The phone couldn't load the part of the app that draws it: is it online?");
    });
    boxes = numberBoxes();
    const html2canvas = (await lib).default;
    const width = paper.width;
    const margin = (PAPER_MARGIN_MM * 72) / 25.4;
    const [pw, ph] = A4_PT;
    const pageHeight = Math.floor((width * (ph - 2 * margin)) / (pw - 2 * margin)); // CSS px of the page on one sheet
    const scale = Math.min(2, 1600 / width); // about 200 dots an inch
    const options: Options = {
      windowWidth: width, // the copy is laid out as wide as the paper
      windowHeight: pageHeight,
      scrollX: 0,
      scrollY: 0,
      scale,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
    };
    const css = paper.css;

    // Where the pages break and where each box is, measured on a copy laid out like the ones drawn: without the
    // insides of the charts (they don't change where anything is), and stopped before it is drawn.
    let cuts: number[] = [];
    let where: Box[] = [];
    const stop = new AbortController();
    try {
      await html2canvas(document.body, {
        ...options,
        signal: stop.signal,
        ignoreElements: (el) => el.tagName === 'NOSCRIPT' || (el as SVGElement).ownerSVGElement != null,
        onclone: async (doc) => {
          await dress(doc, css);
          cuts = pageBreaks(doc, pageHeight);
          where = measureBoxes(doc, boxes.length);
          stop.abort();
        },
      });
    } catch (e) {
      if (!stop.signal.aborted) throw e;
    }
    if (cuts.length < 2) throw plain('There is nothing on the page to put on paper.');

    const fonts = new SvgFonts();
    const pages: PdfPicture[] = [];
    for (let i = 0; i < cuts.length - 1;) {
      // as many pages as fit in one picture
      let j = i + 1;
      while (j < cuts.length - 1 && (cuts[j + 1] - cuts[i]) * width * scale * scale <= BUDGET) j++;
      const top = cuts[i];
      const bottom = cuts[j];
      // the boxes far from these pages are copied empty, at their size: the copy holds only what these pages show
      const far = farBoxes(where, top, bottom);
      const picture = await html2canvas(document.body, {
        ...options,
        x: 0,
        y: top,
        width,
        height: bottom - top,
        ignoreElements: (el) => el.tagName === 'NOSCRIPT' || far.has(boxOf(el.parentElement)),
        onclone: async (doc) => {
          await dress(doc, css);
          doc.querySelectorAll(`[${BOX}]`).forEach((el) => {
            const b = far.get(boxOf(el));
            if (b) keepSize(el as HTMLElement, b);
          });
          await fonts.into(doc, top, bottom);
        },
      });
      try {
        for (let k = i; k < j; k++) {
          const page = await cutPage(picture, (cuts[k] - top) * scale, (cuts[k + 1] - cuts[k]) * scale);
          if (page) pages.push(page);
        }
      } finally {
        free(picture);
      }
      i = j;
    }
    if (!pages.length) throw plain('There is nothing on the page to put on paper.');
    const pdf = pdfOfPictures(pages, { title: name, margin });
    return new File([pdf], `${name}.pdf`, { type: 'application/pdf' });
  } finally {
    boxes.forEach((el) => el.removeAttribute(BOX));
    endPaper();
  }
}

// The copy laid out on paper: the print rules on it, and its fonts loaded before it is measured
async function dress(doc: Document, css: string) {
  const style = doc.createElement('style');
  style.textContent = css;
  doc.head.appendChild(style);
  // html2canvas-pro copies a chart's shapes with the sizes they have on the screen: a shape sized in % of its chart
  // (the photo's shade, as wide as the photo) takes it from the paper again, as it does when printed
  doc.querySelectorAll('svg').forEach((svg) => {
    if ((svg as SVGSVGElement).ownerSVGElement) return;
    for (const el of [svg, ...Array.from(svg.querySelectorAll('*'))] as SVGElement[]) {
      for (const [k, also] of GEOMETRY) {
        if (el.getAttribute(k)?.includes('%')) [k, ...also].forEach((p) => el.style.removeProperty(p));
      }
    }
  });
  void doc.body.offsetHeight; // laid out with them: the fonts it uses are asked for
  await doc.fonts?.ready;
}
// a shape's size and place, as attributes, and the styles of the same name (width is also inline-size)
const GEOMETRY: [string, string[]][] = [['width', ['inline-size']], ['height', ['block-size']], ['x', []], ['y', []],
  ['cx', []], ['cy', []], ['r', []], ['rx', []], ['ry', []]];

// ---------- copying only what is drawn ----------

// html2canvas-pro copies the whole page for each picture (and every style of every shape in a chart), which took
// most of a minute for a long report. Every box that holds other boxes gets a number on the page while the PDF is
// made; the first copy measures where each one is, and each picture's copy leaves out what is inside the boxes far
// from its pages, keeping each such box at its size so nothing between moves.
const BOX = 'data-pdf-box';
const NEAR = 300; // CSS px: a box this near the pages is copied whole (what it holds may reach a little outside it)

type Box = { top: number; bottom: number; width: number; height: number; inline: boolean; parent: number };

const boxOf = (el: Element | null): number => Number(el?.getAttribute(BOX) ?? -1);

function numberBoxes(): Element[] {
  const boxes = Array.from(document.body.querySelectorAll('*')).filter((el) => el.firstElementChild
    && !(el as SVGElement).ownerSVGElement);
  boxes.forEach((el, i) => el.setAttribute(BOX, String(i)));
  return boxes;
}

function measureBoxes(doc: Document, count: number): Box[] {
  const view = doc.defaultView;
  const out: Box[] = new Array(count);
  if (!view) return out;
  doc.querySelectorAll(`[${BOX}]`).forEach((el) => {
    const r = el.getBoundingClientRect();
    out[boxOf(el)] = { top: r.top + view.scrollY, bottom: r.bottom + view.scrollY, width: r.width, height: r.height,
      inline: view.getComputedStyle(el).display === 'inline', parent: boxOf(el.parentElement?.closest(`[${BOX}]`) ?? null) };
  });
  return out;
}

/** The outermost boxes far from `top`..`bottom`, by number. A box drawn inline (words in a line) is never left empty:
 * the lines after it would move. */
function farBoxes(boxes: Box[], top: number, bottom: number): Map<number, Box> {
  const far = new Map<number, Box>();
  const inside = new Set<number>(); // in a far box: left out with it
  boxes.forEach((b, i) => {
    if (!b) return;
    if (far.has(b.parent) || inside.has(b.parent)) {
      inside.add(i);
      return;
    }
    if (b.width > 0 && b.height > 0 && !b.inline && (b.bottom < top - NEAR || b.top > bottom + NEAR)) far.set(i, b);
  });
  return far;
}

function keepSize(el: HTMLElement, b: Box) {
  for (const [k, v] of [['width', `${b.width}px`], ['height', `${b.height}px`], ['min-width', '0'], ['min-height', '0'],
    ['max-width', 'none'], ['max-height', 'none'], ['flex', 'none'], ['box-sizing', 'border-box'],
    ['overflow', 'hidden']]) el.style.setProperty(k, v, 'important');
  el.replaceChildren(); // its words, which are copied anyway
}

/** Where the pages of the copy `doc` break, in CSS px from its top: 0, each break, its end. A page ends at most
 * `height` down, moved up (by up to half a page) to the top of the line, chart, photo or block (KEEP in lib/print.ts)
 * it would cut through; a heading stays with what follows it. */
function pageBreaks(doc: Document, height: number): number[] {
  const y0 = doc.defaultView?.scrollY ?? 0;
  let end = Math.ceil(Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight));
  const whole: [number, number][] = []; // what a break must not cut through, top and bottom
  const add = (r: DOMRect, below = 0) => {
    if (r.width > 0 && r.height > 0) whole.push([r.top + y0, r.bottom + y0 + below]);
  };
  doc.querySelectorAll('[data-print-keep], svg, img').forEach((e) => add(e.getBoundingClientRect()));
  doc.querySelectorAll('[data-print="head"]').forEach((e) => add(e.getBoundingClientRect(), HEAD_ROOM));
  const range = doc.createRange();
  const texts = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = texts.nextNode(); n; n = texts.nextNode()) {
    if (!n.nodeValue?.trim()) continue;
    range.selectNodeContents(n);
    for (const r of Array.from(range.getClientRects())) add(r); // each line
  }
  // no last page of nothing but the page's bottom margin
  let last = 0;
  for (const [, b] of whole) last = Math.max(last, b);
  if (last > 0) end = Math.min(end, Math.ceil(last) + 16);
  const cuts = [0];
  for (let top = 0; end - top > height;) {
    let at = top + height;
    const highest = top + height / 2;
    for (let moved = true; moved;) {
      moved = false;
      for (const [a, b] of whole) {
        if (a < at && b > at && a > highest) {
          at = a;
          moved = true;
        }
      }
    }
    at = Math.floor(at);
    cuts.push(at);
    top = at;
  }
  cuts.push(end);
  return cuts;
}

// One page out of a picture (`y` and `height` in the picture's pixels); null when there is nothing on it
async function cutPage(picture: HTMLCanvasElement, y: number, height: number): Promise<PdfPicture | null> {
  const top = Math.round(y);
  const page = document.createElement('canvas');
  page.width = picture.width;
  page.height = Math.max(1, Math.min(Math.round(height), picture.height - top));
  try {
    const ctx = page.getContext('2d');
    if (!ctx) throw plain('The phone has no room left to draw the page.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, page.width, page.height);
    ctx.drawImage(picture, 0, top, page.width, page.height, 0, 0, page.width, page.height);
    if (blank(page)) return null;
    const blob = await new Promise<Blob | null>((done) => page.toBlob(done, 'image/jpeg', QUALITY));
    if (!blob) throw plain('A page could not be drawn.');
    return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: page.width, height: page.height };
  } finally {
    free(page);
  }
}

// White all over (a page of nothing but the bottom of the page)
function blank(page: HTMLCanvasElement): boolean {
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(page.width / 4));
  small.height = Math.max(1, Math.round(page.height / 4));
  try {
    const ctx = small.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(page, 0, 0, small.width, small.height);
    const px = ctx.getImageData(0, 0, small.width, small.height).data;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 735) return false;
    return true;
  } finally {
    free(small);
  }
}

// Safari keeps a canvas's memory until it is made empty
function free(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

/** The app's faces inside the charts. html2canvas-pro draws a chart (react-native-svg's <svg>) as a picture of it, and
 * a picture can't use the page's fonts: each chart on the pages being drawn gets the faces its text uses, inline. */
class SvgFonts {
  private faces = new Map<string, Promise<string>>(); // family -> its @font-face rule, the font inline ('' if none)

  async into(doc: Document, top: number, bottom: number) {
    const view = doc.defaultView;
    if (!view) return;
    const jobs: Promise<void>[] = [];
    doc.querySelectorAll('svg').forEach((svg) => {
      const r = svg.getBoundingClientRect();
      if (r.bottom + view.scrollY < top || r.top + view.scrollY > bottom) return;
      const families = new Set<string>();
      svg.querySelectorAll('text').forEach((t) => {
        const f = view.getComputedStyle(t).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
        if (f) families.add(f);
      });
      if (!families.size) return;
      jobs.push(Promise.all([...families].map((f) => this.face(f))).then((rules) => {
        const css = rules.filter(Boolean).join('\n');
        if (!css) return;
        const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
        style.textContent = css;
        svg.insertBefore(style, svg.firstChild);
      }));
    });
    await Promise.all(jobs);
  }

  private face(family: string): Promise<string> {
    let rule = this.faces.get(family);
    if (!rule) {
      rule = inlineFace(family).catch(() => ''); // without it the chart's text takes the browser's own face
      this.faces.set(family, rule);
    }
    return rule;
  }
}

// The page's @font-face of `family` with the font file in it
async function inlineFace(family: string): Promise<string> {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a style sheet from another site
    }
    for (const r of Array.from(rules)) {
      if (!(r instanceof CSSFontFaceRule)) continue;
      if (r.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '') !== family) continue;
      const url = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(r.style.getPropertyValue('src'))?.[1];
      if (!url) continue;
      const blob = await (await fetch(new URL(url, document.baseURI).href)).blob();
      const data = await new Promise<string>((done, fail) => {
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result));
        reader.onerror = () => fail(reader.error);
        reader.readAsDataURL(blob);
      });
      const weight = r.style.getPropertyValue('font-weight');
      const style = r.style.getPropertyValue('font-style');
      return `@font-face { font-family: "${family}"; src: url(${data});${weight ? ` font-weight: ${weight};` : ''}`
        + `${style ? ` font-style: ${style};` : ''} }`;
    }
  }
  return '';
}
