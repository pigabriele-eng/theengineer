#!/usr/bin/env node
// After `expo export -p web`: lets the browser fetch the programme's fonts while it is still fetching and running the
// app's script. The app draws its first page only once every face is loaded (app/_layout.tsx), and the faces are asked
// for only when the script runs, so without this the fonts came after the script, one wait after the other. Adds a
// <link rel="preload"> for each font the export holds (the ones the app loads; their names carry a content hash) to
// the exported index.html.
//
//   node scripts/web-preload.mjs [dist]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DIST = process.argv[2] ?? 'dist';
const FONT = /\.(ttf|otf|woff2?)$/i;

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

const index = join(DIST, 'index.html');
let html = readFileSync(index, 'utf8');
const assets = join(DIST, 'assets');
const fonts = existsSync(assets) ? files(assets).filter((f) => FONT.test(f)).sort() : [];
const links = fonts
  .map((f) => `/${relative(DIST, f).split(sep).join('/')}`)
  .filter((href) => !html.includes(`href="${encodeURI(href)}"`))
  .map((href) => {
    const type = href.split('.').pop().toLowerCase();
    return `<link rel="preload" href="${encodeURI(href)}" as="font" type="font/${type}" crossorigin>`;
  });
if (links.length) {
  html = html.replace('</head>', `${links.join('')}</head>`);
  writeFileSync(index, html);
}
console.log(`web-preload: ${links.length} font${links.length === 1 ? '' : 's'} preloaded in ${index}`);
