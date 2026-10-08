#!/usr/bin/env node
// Readable and accessible: an audit of the built web app (npx expo export -p web) in Chromium, with Playwright.
//
// Each page is opened at 390 px (a phone) and 1100 px wide, in Light and in Dark (Tools › Appearance set to System and
// the browser's prefers-color-scheme emulated), and checked for:
//   contrast  every visible text against what is behind it: the first background up its parents or, for text over a
//             photo (or a chart label over a filled shape), the pixels behind its box in a screenshot taken with all
//             text hidden. WCAG AA: 4.5:1, or 3:1 for large text (24 px, or bold and 18.66 px). Light and Dark.
//   size      no text under 12 px; on a phone, no reading text (a paragraph of more than 60 characters) under 16 px.
//   targets   every button, link, tab, radio, tick box, input and anything with a pointer cursor is at least 44 x 44 CSS
//             px. React Native's hitSlop never reaches the DOM, so a smaller element fails even when it has one.
//   names     every control in the accessibility tree has a name (Playwright's aria snapshot).
//   overflow  nothing wider than the window and no text cut off at its edge, at 390 px and at 1100 px with 200% zoom
//             (a 550 px window at device scale 2).
//   focus     each of the first 10 stops of the Tab key shows a visible change (outline, shadow, border or background).
//   states    every tick box, radio and switch says whether it is on (aria-checked), and what a control tells the phone
//             about itself (React Native's accessibilityState, read from the React props that drew it) reaches the web
//             too: open or folded (aria-expanded: a button that opens a disclosure, like a run's tyre tag), ticked
//             (aria-checked) and picked (aria-selected; aria-pressed on a button, aria-current on a link).
//             react-native-web reads only the aria-* props, never accessibilityState (lib/a11yState.ts gives both).
// A page's score is the mean of the seven checks' pass shares. Prints a table and saves every failure as JSON.
//
// Usage, from app/ after a web export:
//   node scripts/a11y-audit.mjs --dist dist [--port 8832] [--pages "home=/,event=/event/1"] [--out a11y.json] [--merge]
//   node scripts/a11y-audit.mjs --base http://localhost:8832 ...         an app that is already served
//   node scripts/a11y-audit.mjs --compare before.json after.json         a Markdown table of two audits
// Without --pages it audits the main pages, with the ids of the Hockenheim test imported into an empty local server.
// --merge adds the pages to the --out file instead of replacing it. Playwright isn't one of the app's dependencies:
// PLAYWRIGHT names its index.mjs and CHROMIUM the browser to launch (defaults below).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

const PLAYWRIGHT = process.env.PLAYWRIGHT ?? '/opt/node-tools/node_modules/playwright/index.mjs';
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';

const DEFAULT_PAGES = {
  home: '/',
  event: '/event/1',
  run: '/session/7',
  report: '/report?event=1',
  technique: '/technique?event=1',
  compare: '/compare?session=7',
  prep: '/prep?event=1',
  seasons: '/seasons',
  tools: '/tools',
  debrief: '/debrief',
  fingerprints: '/drivers/fingerprints',
  upload: '/upload',
};

const CHECKS = ['contrast', 'size', 'targets', 'names', 'overflow', 'focus', 'states'];
const MIN_TARGET = 44;

// The windows each page is opened in, and what is checked in each: sizes, targets, names and states don't depend on
// the scheme, so they are checked in Light only.
const RUNS = [
  { id: '390 light', width: 390, height: 844, scheme: 'light', phone: true,
    checks: ['contrast', 'size', 'targets', 'names', 'overflow', 'states'] },
  { id: '390 dark', width: 390, height: 844, scheme: 'dark', phone: true, checks: ['contrast'] },
  { id: '1100 light', width: 1100, height: 900, scheme: 'light',
    checks: ['contrast', 'size', 'targets', 'names', 'focus', 'states'] },
  { id: '1100 dark', width: 1100, height: 900, scheme: 'dark', checks: ['contrast'] },
  { id: '1100 at 200%', width: 550, height: 450, scale: 2, scheme: 'light', checks: ['overflow'] },
];

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'merge') out.merge = true;
    else if (key === 'compare') out.compare = [argv[++i], argv[++i]];
    else out[key] = argv[++i];
  }
  return out;
}

// ---------- serving the export ----------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json' };

/** Serves a single-page export: a file when there is one, else index.html. */
function serve(dir, port) {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = resolve(join(root, path));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) file = join(root, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

// ---------- in the page ----------

// Runs in the page: every visible text with its colours, every control with its size, and what overflows.
function collect({ phone, sampleSvg }) {
  const W = innerWidth;
  const parse = (s) => {
    if (!s) return null;
    let m = s.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = s.match(/^color\(srgb ([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    return null;
  };
  const over = (f, b) => {
    const a = f.a + b.a * (1 - f.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (x, y) => (x * f.a + y * b.a * (1 - f.a)) / a;
    return { r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b), a };
  };
  const lum = (c) => {
    const f = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const meets = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const hiddenAxis = (v) => v === 'hidden' || v === 'clip';
  const styleOf = new Map();
  const cs = (e) => {
    let s = styleOf.get(e);
    if (!s) styleOf.set(e, (s = getComputedStyle(e)));
    return s;
  };

  // folded away or clipped out of sight by an ancestor that hides its overflow (up to a scroller on that axis: what
  // is past a scroller's edge is scrolled to, not hidden)
  const scrolls = (v) => v === 'auto' || v === 'scroll';
  const clippedAway = (el, r) => {
    let freeX = false;
    let freeY = false;
    for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const s = cs(e);
      if ((!freeX && hiddenAxis(s.overflowX)) || (!freeY && hiddenAxis(s.overflowY))) {
        const er = e.getBoundingClientRect();
        if (!freeX && hiddenAxis(s.overflowX) && (r.right <= er.left + 0.5 || r.left >= er.right - 0.5)) return true;
        if (!freeY && hiddenAxis(s.overflowY) && (r.bottom <= er.top + 0.5 || r.top >= er.bottom - 0.5)) return true;
      }
      if (scrolls(s.overflowX)) freeX = true;
      if (scrolls(s.overflowY)) freeY = true;
      if (freeX && freeY) break;
    }
    return false;
  };
  const opacity = (el, stop) => {
    let o = 1;
    for (let e = el; e && e !== stop && e.nodeType === 1; e = e.parentElement) o *= Number(cs(e).opacity);
    return o;
  };
  // the backgrounds behind an element, laid over each other up to the first opaque one (`base`)
  const backdrop = (el) => {
    const layers = [];
    let base = document.documentElement;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = parse(cs(e).backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 0.999) {
          base = e;
          break;
        }
      }
    }
    let color = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) color = over(layers[i], color);
    return { color, base };
  };

  // photos: an <img>, or a box painted with a picture (React Native Web draws an Image as a background-image)
  const pictures = [];
  for (const e of document.body.querySelectorAll('*')) {
    if (e.tagName === 'IMG' || /url\(/.test(cs(e).backgroundImage)) {
      const r = e.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) pictures.push({ e, r });
    }
  }
  const overPicture = (el, base, r) =>
    pictures.some((p) => base.contains(p.e) && !p.e.contains(el) && meets(p.r, r));
  // a chart's label over a filled shape drawn before it (a bar, a band)
  const overShape = (el, r) => {
    const svg = el.ownerSVGElement ?? el.closest('svg');
    if (!svg) return false;
    for (const s of svg.querySelectorAll('rect,path,circle,ellipse,polygon')) {
      if (!(s.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const f = parse(cs(s).fill);
      if (!f || f.a === 0 || Number(cs(s).fillOpacity) === 0 || Number(cs(s).opacity) === 0) continue;
      if (meets(s.getBoundingClientRect(), r)) return true;
    }
    return false;
  };
  const inScroller = (el) => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const s = cs(e);
      if (scrolls(s.overflowX) && e.scrollWidth > e.clientWidth + 1) return true;
    }
    return false;
  };
  const blockOf = (el) => {
    let e = el;
    while (e && e.parentElement && cs(e).display.startsWith('inline')) e = e.parentElement;
    return e;
  };
  const near = (el) => {
    const host = el.closest('[aria-label],[role]');
    return host ? (host.getAttribute('aria-label') || host.getAttribute('role')) : '';
  };

  const texts = [];
  const nodes = [];
  const cut = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = n.nodeValue.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const el = n.parentElement;
    if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE'].includes(el.tagName)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    const st = cs(el);
    if (st.visibility !== 'visible') continue;
    // past the window's edge, outside a sideways scroller: cut off (or shown only by scrolling the whole page)
    if ((r.right > W + 1 || r.left < -1) && !inScroller(el)) cut.push({ text: s.slice(0, 50), x: Math.round(r.left), w: Math.round(r.width) });
    if (clippedAway(el, r)) continue;
    const svg = el instanceof SVGElement;
    const fg = parse(svg ? st.fill : st.color);
    if (!fg || fg.a === 0) continue;
    const allFade = opacity(el, null);
    if (allFade < 0.02) continue;
    // the words of a control that is switched off need no contrast (WCAG 1.4.3: inactive components)
    const off = el.closest('[aria-disabled="true"],:disabled');
    const size = parseFloat(st.fontSize);
    const bold = Number(st.fontWeight) >= 700 || /Bold|Anton/i.test(st.fontFamily);
    const large = size >= 24 || (bold && size >= 18.66);
    const { color: bg, base } = backdrop(el);
    const sample = overPicture(el, base, r) || (sampleSvg && svg && overShape(el, r));
    const fgOver = { ...fg, a: fg.a * (sample ? allFade : opacity(el, base)) };
    const ink = over(fgOver, bg);
    const item = {
      text: s.slice(0, 70), size: Math.round(size * 10) / 10, bold, large, svg, near: near(el),
      fg: hex(ink), bg: hex(bg), ratio: Math.round(ratio(ink, bg) * 100) / 100, sample, fgAlpha: fgOver.a,
      fgRaw: fg, off: Boolean(off), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      para: (blockOf(el)?.innerText ?? s).replace(/\s+/g, ' ').trim().length,
    };
    item.i = nodes.length;
    nodes.push(n);
    texts.push(item);
  }
  window.__a11yNodes = nodes;

  // controls
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=radio],' +
    '[role=checkbox],[role=switch],[role=menuitem],[role=option],[role=slider],[tabindex]:not([tabindex="-1"])';
  const cands = new Set(document.body.querySelectorAll(SEL));
  for (const e of document.body.querySelectorAll('*')) {
    if (cs(e).cursor === 'pointer' && (!e.parentElement || cs(e.parentElement).cursor !== 'pointer')) cands.add(e);
  }
  const visible = (e, r) => r.width > 0 && r.height > 0 && cs(e).visibility === 'visible' && !clippedAway(e, r) &&
    opacity(e, null) > 0.02 && e.getAttribute('aria-disabled') !== 'true' && !e.disabled;
  const targets = [];
  for (const e of cands) {
    const r = e.getBoundingClientRect();
    if (!visible(e, r)) continue;
    // the same target drawn twice (a link around its own pressable): counted once
    let dup = false;
    for (let p = e.parentElement; p; p = p.parentElement) {
      if (!cands.has(p)) continue;
      const pr = p.getBoundingClientRect();
      if (Math.abs(pr.width - r.width) < 1.5 && Math.abs(pr.height - r.height) < 1.5) dup = true;
      break;
    }
    if (dup) continue;
    const label = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || '').replace(/\s+/g, ' ')
      .trim().slice(0, 50);
    targets.push({ role: e.getAttribute('role') || e.tagName.toLowerCase(), label, w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10 });
  }

  // states: the accessibilityState a control was drawn with is in the props of the React components between it and the
  // element above it (Pressable, View, Text); the attributes the web needs for each part of it
  const fiberKey = (e) => Object.keys(e).find((k) => k.startsWith('__reactFiber$'));
  const declared = (e) => {
    const key = fiberKey(e);
    for (let f = key ? e[key].return : null; f && f.tag !== 3 && !(f.stateNode instanceof Element); f = f.return) {
      const s = f.memoizedProps?.accessibilityState;
      if (s && typeof s === 'object') return s;
    }
    return null;
  };
  const TICKED = ['checkbox', 'radio', 'switch'];
  const states = [];
  for (const e of document.body.querySelectorAll('*')) {
    const role = e.getAttribute('role');
    const s = declared(e);
    if (!TICKED.includes(role) && !s) continue;
    const r = e.getBoundingClientRect();
    // a disabled one still says whether it is ticked: not left out like a target
    if (r.width <= 0 || r.height <= 0 || cs(e).visibility !== 'visible' || clippedAway(e, r)) continue;
    if (opacity(e, null) <= 0.02) continue;
    const want = []; // [attribute, the value it should have, or null for any]
    if (TICKED.includes(role) || s?.checked != null) {
      want.push(['aria-checked', s?.checked != null ? String(s.checked) : null]);
    }
    if (s?.expanded != null) want.push(['aria-expanded', String(s.expanded)]);
    // picked: a browser keeps aria-selected only on a tab, an option, a row or a cell; a picked button is pressed, a
    // picked link the page it is on, and a radio, tick box or switch says it by aria-checked alone
    if (s?.selected != null && !TICKED.includes(role)) {
      if (role === 'button') want.push(['aria-pressed', String(s.selected)]);
      else if (role === 'link') want.push(['aria-current', s.selected ? 'page' : 'false']);
      else want.push(['aria-selected', String(s.selected)]);
    }
    const label = (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    for (const [attr, value] of want) {
      const got = e.getAttribute(attr);
      states.push({ role: role || e.tagName.toLowerCase(), label, attr, want: value ?? 'true or false', got,
        pass: got != null && (value == null || got === value) });
    }
  }

  // overflow: wider than the window, or text past its edge outside a sideways scroller
  const docWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  return { phone, width: W, texts, targets, states, overflow: { docWidth, cut } };
}

// Runs in the page with all text hidden: the pixels behind each text that needs them, from a screenshot of the
// window. Returns the contrast that 90% of those pixels give (a photo is never one colour).
async function sampleShot({ b64, want }) {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const k = img.width / innerWidth;
  const lum = (r, g, b) => {
    const f = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const out = {};
  for (const { i, fg } of want) {
    const node = window.__a11yNodes[i];
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) continue;
    const x = Math.floor(r.left * k);
    const y = Math.floor(r.top * k);
    const w = Math.max(1, Math.floor(r.width * k));
    const h = Math.max(1, Math.floor(r.height * k));
    const data = ctx.getImageData(x, y, w, h).data;
    const ratios = [];
    let sr = 0;
    let sg = 0;
    let sb = 0;
    const step = Math.max(1, Math.floor((w * h) / 20000));
    for (let p = 0; p < data.length; p += 4 * step) {
      const [br, bgc, bb] = [data[p], data[p + 1], data[p + 2]];
      const a = fg.a;
      const ir = fg.r * a + br * (1 - a);
      const ig = fg.g * a + bgc * (1 - a);
      const ib = fg.b * a + bb * (1 - a);
      const l1 = lum(ir, ig, ib);
      const l2 = lum(br, bgc, bb);
      ratios.push((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
      sr += br;
      sg += bgc;
      sb += bb;
    }
    ratios.sort((a, b) => a - b);
    const n = ratios.length;
    const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
    out[i] = { ratio: Math.round(ratios[Math.floor(n * 0.1)] * 100) / 100, bg: `#${hex(sr)}${hex(sg)}${hex(sb)}` };
  }
  return out;
}

const HIDE_TEXT = '*{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;' +
  'caret-color:transparent!important;text-decoration-color:transparent!important}svg text,svg tspan{fill:transparent!important;' +
  'stroke:transparent!important}';

async function sampleTexts(page, texts) {
  const todo = texts.filter((t) => t.sample);
  if (!todo.length) return;
  const style = await page.addStyleTag({ content: HIDE_TEXT });
  const done = new Set();
  for (const t of todo) {
    if (done.has(t.i)) continue;
    await page.evaluate((i) => window.__a11yNodes[i].parentElement.scrollIntoView({ block: 'center', inline: 'nearest' }), t.i);
    await page.waitForTimeout(60);
    const shot = await page.screenshot({ type: 'png', animations: 'disabled' });
    const want = todo.filter((u) => !done.has(u.i)).map((u) => ({ i: u.i, fg: { ...u.fgRaw, a: u.fgAlpha } }));
    const got = await page.evaluate(sampleShot, { b64: shot.toString('base64'), want });
    for (const u of todo) {
      const g = got[u.i];
      if (!g) continue;
      u.ratio = g.ratio;
      u.bg = g.bg;
      u.sampled = true;
      done.add(u.i);
    }
    done.add(t.i);
  }
  await style.evaluate((e) => e.remove());
}

// The first 10 stops of the Tab key: does each one show it has the focus?
async function focusStops(page) {
  await page.evaluate(() => {
    const sig = (e) => {
      const s = getComputedStyle(e);
      return JSON.stringify([s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor,
        s.textDecorationLine]);
    };
    window.__a11ySig = sig;
    window.__a11yPre = new Map();
    for (const e of document.body.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')) {
      window.__a11yPre.set(e, sig(e));
    }
    document.activeElement?.blur?.();
  });
  const stops = [];
  for (let k = 0; k < 10; k++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body || e === document.documentElement) return null;
      const s = getComputedStyle(e);
      const pre = window.__a11yPre.get(e);
      const now = window.__a11ySig(e);
      const a = (c) => {
        const m = c.match(/rgba?\(([^)]+)\)/);
        return m ? (m[1].split(/[\s,/]+/).filter(Boolean).map(Number)[3] ?? 1) : 1;
      };
      const ring = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && a(s.outlineColor) > 0;
      const [, , , shadow, border, bg] = JSON.parse(now);
      const p = pre ? JSON.parse(pre) : null;
      const changed = !p || ring && (p[0] !== s.outlineStyle || p[1] !== s.outlineWidth) || p[3] !== shadow ||
        p[4] !== border || p[5] !== bg;
      const label = (e.getAttribute('aria-label') || e.innerText || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 40);
      return { label, visible: Boolean(changed && (ring || p)), outline: `${s.outlineStyle} ${s.outlineWidth}` };
    });
    if (!stop) break;
    stops.push(stop);
  }
  return stops;
}

const CONTROL_ROLES = 'button|link|tab|radio|checkbox|switch|textbox|combobox|menuitem|option|slider|searchbox|spinbutton';

/** Controls in the aria snapshot, and the ones without a name. */
function namesOf(snapshot) {
  const re = new RegExp(`^\\s*- (${CONTROL_ROLES})(?=[\\s:\\[]|$)(.*)$`);
  const controls = [];
  for (const line of snapshot.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const rest = m[2].trim();
    const named = rest.startsWith('"') || rest.startsWith('/');
    controls.push({ role: m[1], named, line: line.trim().slice(0, 80) });
  }
  return controls;
}

// ---------- one page in one window ----------

// The page has drawn what it will draw: its text has stopped changing for 2 s and no spinner turns (React Native's
// ActivityIndicator is a progressbar without a value: a page still working something out), at most 90 s.
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => {
    const spinning = [...document.querySelectorAll('[role=progressbar]')]
      .some((e) => !e.hasAttribute('aria-valuenow') && e.getBoundingClientRect().width > 0);
    const text = document.body.innerText.length;
    const now = Date.now();
    const w = (window.__a11ySettle ??= { text: -1, since: now });
    if (text !== w.text || spinning) {
      w.text = text;
      w.since = now;
    }
    return now - w.since >= 2000;
  }, null, { timeout: 90000, polling: 250 }).catch(() => {});
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(700);
}

async function audit(browser, base, name, path, run) {
  const context = await browser.newContext({
    viewport: { width: run.width, height: run.height },
    deviceScaleFactor: run.scale ?? 1,
    isMobile: Boolean(run.phone),
    hasTouch: Boolean(run.phone),
    colorScheme: run.scheme,
  });
  // Appearance "System": the app follows the emulated prefers-color-scheme
  await context.addInitScript(() => {
    try {
      localStorage.setItem('theengineer.appearance', 'system');
    } catch {}
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const result = { run: run.id, errors };
  try {
    await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page);
    const got = await page.evaluate(collect, { phone: Boolean(run.phone), sampleSvg: true });
    if (run.checks.includes('contrast')) await sampleTexts(page, got.texts);
    if (run.checks.includes('contrast')) {
      result.contrast = got.texts.filter((t) => !t.off).map((t) => ({ ...t, pass: t.ratio >= (t.large ? 3 : 4.5) }));
    }
    if (run.checks.includes('size')) {
      result.size = got.texts.map((t) => {
        const tiny = t.size < 12;
        const body = run.phone && t.para > 60 && t.size < 16 && !t.svg;
        return { text: t.text, size: t.size, para: t.para, svg: t.svg, near: t.near, tiny, body, pass: !tiny && !body };
      });
    }
    if (run.checks.includes('targets')) {
      result.targets = got.targets.map((t) => ({ ...t, pass: t.w >= MIN_TARGET - 0.5 && t.h >= MIN_TARGET - 0.5 }));
    }
    if (run.checks.includes('names')) {
      const snap = await page.locator('body').ariaSnapshot({ timeout: 20000 }).catch(() => '');
      result.names = namesOf(snap).map((c) => ({ ...c, pass: c.named }));
    }
    if (run.checks.includes('overflow')) {
      const o = got.overflow;
      result.overflow = [{ run: run.id, docWidth: o.docWidth, width: got.width, cut: o.cut.slice(0, 10),
        pass: o.docWidth <= got.width + 1 && o.cut.length === 0 }];
    }
    if (run.checks.includes('states')) result.states = got.states;
    if (run.checks.includes('focus')) {
      result.focus = (await focusStops(page)).map((s) => ({ ...s, pass: s.visible }));
    }
  } catch (e) {
    result.failed = String(e).slice(0, 300);
  }
  await context.close();
  return result;
}

// ---------- scores and tables ----------

function score(runs) {
  const cats = {};
  for (const c of CHECKS) {
    const items = runs.flatMap((r) => (r[c] ?? []).map((x) => ({ ...x, run: r.run })));
    const pass = items.filter((x) => x.pass).length;
    cats[c] = { pass, total: items.length, fails: items.filter((x) => !x.pass) };
  }
  const shares = CHECKS.filter((c) => cats[c].total > 0).map((c) => cats[c].pass / cats[c].total);
  const total = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;
  return { score: Math.round(total * 1000) / 10, cats };
}

// (an audit saved before a check existed has none of it)
const pct = (c) => (c?.total ? `${Math.round((c.pass / c.total) * 100)}%` : 'n/a');
const failsOf = (c) => (c?.total ? `${c.total - c.pass}/${c.total}` : '-');

function table(pages) {
  const head = '| page | score | contrast fails | size fails (<12 px / phone body <16) | targets <44 px | unnamed controls | ' +
    'overflow (390 / 200%) | focus not visible | states missing |';
  const rows = [head, '|---|---|---|---|---|---|---|---|---|'];
  for (const [name, p] of Object.entries(pages)) {
    const c = p.cats;
    const tiny = c.size.fails.filter((f) => f.tiny).length;
    const body = c.size.fails.filter((f) => f.body).length;
    const ov = p.runs.filter((r) => r.overflow).map((r) => (r.overflow[0].pass ? 'ok' : 'over')).join(' / ');
    rows.push(`| ${name} | ${p.score} | ${failsOf(c.contrast)} | ${failsOf(c.size)} (${tiny} / ${body}) | ` +
      `${failsOf(c.targets)} | ${failsOf(c.names)} | ${ov || '-'} | ${failsOf(c.focus)} | ${failsOf(c.states)} |`);
  }
  return rows.join('\n');
}

function compare(beforeFile, afterFile) {
  const a = JSON.parse(readFileSync(beforeFile, 'utf8')).pages;
  const b = JSON.parse(readFileSync(afterFile, 'utf8')).pages;
  const rows = ['| page | before | after | contrast | size | targets | names | overflow | focus | states |',
    '|---|---|---|---|---|---|---|---|---|---|'];
  for (const name of Object.keys({ ...a, ...b })) {
    const x = a[name];
    const y = b[name];
    const cell = (c) => `${x ? pct(x.cats[c]) : '-'} → ${y ? pct(y.cats[c]) : '-'}`;
    rows.push(`| ${name} | ${x?.score ?? '-'} | ${y?.score ?? '-'} | ${CHECKS.map(cell).join(' | ')} |`);
  }
  return rows.join('\n');
}

// ---------- main ----------

async function main() {
  const opt = args(process.argv.slice(2));
  if (opt.compare) {
    console.log(compare(...opt.compare));
    return;
  }
  const out = opt.out ?? 'a11y-audit.json';
  let pages = DEFAULT_PAGES;
  if (opt.pages) {
    pages = Object.fromEntries(opt.pages.split(',').map((kv) => {
      const at = kv.indexOf('=');
      return [kv.slice(0, at).trim(), kv.slice(at + 1).trim()];
    }));
  }
  let server = null;
  let base = opt.base;
  if (!base) {
    const port = Number(opt.port ?? 8832);
    server = await serve(opt.dist ?? 'dist', port);
    base = `http://localhost:${port}`;
  }
  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const jobs = Object.entries(pages).flatMap(([name, path]) => RUNS.map((run) => ({ name, path, run })));
  const results = {};
  const width = Number(opt.jobs ?? 4);
  let next = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const r = await audit(browser, base, job.name, job.path, job.run);
      (results[job.name] ??= []).push(r);
      console.error(`${job.name} ${job.run.id}${r.failed ? ` FAILED ${r.failed}` : ''} (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }));
  await browser.close();
  server?.close();

  const scored = {};
  for (const [name, path] of Object.entries(pages)) {
    const runs = (results[name] ?? []).sort((x, y) => RUNS.findIndex((r) => r.id === x.run) - RUNS.findIndex((r) => r.id === y.run));
    const s = score(runs);
    // keep the failures, not every passing text
    const lean = runs.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
      [k, CHECKS.includes(k) ? { total: v.length, fails: v.filter((x) => !x.pass), ...(k === 'focus' ? { stops: v } : null) }
        : v])));
    scored[name] = { path, score: s.score,
      cats: Object.fromEntries(Object.entries(s.cats).map(([k, v]) => [k, { pass: v.pass, total: v.total, fails: v.fails }])),
      runs: lean.map((r) => ({ ...r, overflow: r.overflow ? [{ pass: r.overflow.fails.length === 0, ...(r.overflow.fails[0] ?? {}) }] : undefined })),
      errors: [...new Set(runs.flatMap((r) => r.errors))] };
  }
  let doc = { made: new Date().toISOString(), base, pages: scored };
  if (opt.merge && existsSync(out)) {
    const old = JSON.parse(readFileSync(out, 'utf8'));
    doc = { ...old, made: doc.made, pages: { ...old.pages, ...scored } };
  }
  writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(table(doc.pages));
  console.log(`\nscore = mean of the seven checks' pass shares; details in ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
