#!/usr/bin/env node
// Draws the app's icon, the race programme's way: a square ink tile, "TE" in the programme's headline face (Anton) in
// paper colour, and a thin programme-red rule under it. Every size the app needs comes from that one drawing:
//
//   assets/images/icon.png              1024 px  the app icon (app.json "icon")
//   assets/images/favicon.png             48 px  made into the browser tab's favicon.ico by `expo export`
//   public/icons/icon-192.png, icon-512.png      the icons of the installed web app (public/manifest.json)
//   public/icons/maskable-512.png                the same drawing smaller, with room around it, for a desktop or
//                                                phone that crops the icon to a circle or a rounded square
//   public/icons/apple-touch-icon.png    180 px  Safari's "Add to Dock" and "Add to Home Screen"
//
// The colours are read from constants/Colors.ts (the light programme: paper, ink and mark), the font from
// @expo-google-fonts/anton. Needs ImageMagick (`magick`, or `convert` for ImageMagick 6). Run it again after a change
// of look:   npm run app-icons
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const FONT = join(APP, 'node_modules/@expo-google-fonts/anton/400Regular/Anton_400Regular.ttf');

// The light palette's paper, ink and red mark, as the app draws them
const colors = readFileSync(join(APP, 'constants/Colors.ts'), 'utf8');
const light = colors.slice(colors.indexOf('const light: Palette = {'), colors.indexOf('const dark: Palette = {'));
function color(key) {
  const m = light.match(new RegExp(`\\n  ${key}: '(#[0-9A-Fa-f]{6})'`));
  if (!m) throw new Error(`app-icons: no light ${key} colour in constants/Colors.ts`);
  return m[1];
}
const PAPER = color('background');
const INK = color('text');
const MARK = color('mark');

function hasCommand(cmd) {
  try {
    execFileSync(cmd, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const IM = hasCommand('magick') ? 'magick' : 'convert';
const im = (...args) => execFileSync(IM, args, { encoding: 'utf8' });

// Drawn at MASTER px and scaled down for each file. The proportions are of the tile's side.
const MASTER = 1024;
const LETTERS = 0.46; // height of the capitals
const GAP = 0.06; // capitals to rule
const RULE = 0.025; // thickness of the red rule

const work = mkdtempSync(join(tmpdir(), 'app-icons-'));
try {
  // The capitals alone, cut to their own outline, so they are centred by what is drawn and not by the font's line box
  const letters = join(work, 'letters.png');
  im('-background', 'none', '-fill', PAPER, '-font', FONT, '-pointsize', '1200', 'label:TE', '-trim', '+repage', letters);
  const [w0, h0] = im(letters, '-format', '%w %h', 'info:').trim().split(' ').map(Number);

  // One tile: the capitals and the rule as one block, centred; `scale` shrinks the block (the maskable icon)
  function tile(file, scale) {
    const h = Math.round(MASTER * LETTERS * scale);
    const w = Math.round((w0 * h) / h0);
    const gap = Math.round(MASTER * GAP * scale);
    const rule = Math.round(MASTER * RULE * scale);
    const x = Math.round((MASTER - w) / 2);
    const y = Math.round((MASTER - (h + gap + rule)) / 2);
    const ruleTop = y + h + gap;
    im(
      '-size', `${MASTER}x${MASTER}`, `xc:${INK}`,
      '(', letters, '-resize', `${w}x${h}!`, ')',
      '-geometry', `+${x}+${y}`, '-composite',
      '-fill', MARK, '-draw', `rectangle ${x},${ruleTop} ${x + w - 1},${ruleTop + rule - 1}`,
      file,
    );
  }
  const full = join(work, 'full.png');
  const padded = join(work, 'padded.png');
  tile(full, 1);
  // A maskable icon is cut to as little as the circle in its middle 80 %: the block shrinks to well inside it
  tile(padded, 0.78);

  // Opaque PNGs with no date or other metadata, so running this again makes the same files
  function write(source, size, out) {
    const path = join(APP, out);
    mkdirSync(join(path, '..'), { recursive: true });
    im(source, '-resize', `${size}x${size}`, '-strip', '-define', 'png:exclude-chunks=date,time', `PNG24:${path}`);
    console.log(`app-icons: ${out} (${size} px)`);
  }
  write(full, 1024, 'assets/images/icon.png');
  write(full, 48, 'assets/images/favicon.png');
  write(full, 192, 'public/icons/icon-192.png');
  write(full, 512, 'public/icons/icon-512.png');
  write(full, 180, 'public/icons/apple-touch-icon.png');
  write(padded, 512, 'public/icons/maskable-512.png');
} finally {
  rmSync(work, { recursive: true, force: true });
}
