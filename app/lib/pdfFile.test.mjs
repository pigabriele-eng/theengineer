// The PDF of pictures (lib/pdfFile.ts): its pages, the cross-reference table pointing at each object, the title, and
// each picture placed inside the margins. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { A4_PT, pdfOfPictures } from './pdfFile.ts';

// a 4 x 3 pixel JPEG, red
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0o'
  + 'MCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAQD'
  + 'ASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKB'
  + 'kaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZ'
  + 'mqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQF'
  + 'BgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5'
  + 'OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX'
  + '2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgKKKK+eP2E//Z',
  'base64',
);

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

test('a page for each picture, every object where the cross-reference table says', () => {
  const pdf = pdfOfPictures(
    [{ jpeg: JPEG, width: 4, height: 3 }, { jpeg: JPEG, width: 4, height: 3 }],
    { title: 'Driver fingerprints', margin: 34, date: new Date(Date.UTC(2026, 9, 7, 19, 0, 5)) },
  );
  const text = latin1(pdf);
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.endsWith('%%EOF\n'));
  assert.match(text, /\/Type \/Pages \/Kids \[4 0 R 7 0 R\] \/Count 2/);
  assert.equal(text.match(/\/Type \/Page /g).length, 2);
  assert.equal(text.match(/\/Filter \/DCTDecode \/Length 633 /g).length, 2);
  assert.match(text, /\/CreationDate \(D:20261007190005Z\)/);
  // the xref offsets point at "n 0 obj"
  const xref = Number(/startxref\n(\d+)\n/.exec(text)[1]);
  assert.ok(text.slice(xref).startsWith('xref\n0 10\n'));
  const rows = text.slice(xref).split('\n').slice(3, 12);
  rows.forEach((row, i) => {
    assert.equal(row.length, 19); // with its line end, 20 bytes
    assert.ok(text.slice(Number(row.slice(0, 10))).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1}`);
  });
  // the JPEG goes in byte for byte
  assert.ok(Buffer.from(pdf).includes(JPEG));
});

test('the title in UTF-16, any character', () => {
  const pdf = latin1(pdfOfPictures([{ jpeg: JPEG, width: 4, height: 3 }], { title: 'Report · T2–T5', margin: 0 }));
  // "R" 0052, the middle dot 00B7, the en dash 2013
  assert.match(pdf, /\/Title <FEFF0052[0-9A-F]*00B7[0-9A-F]*2013[0-9A-F]*>/);
});

test('the picture across the page inside the margins, from the top; a tall one made smaller to fit', () => {
  const [pw, ph] = A4_PT;
  const wide = latin1(pdfOfPictures([{ jpeg: JPEG, width: 400, height: 300 }], { title: 'x', margin: 34 }));
  const [w, h, x, y] = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/.exec(wide).slice(1).map(Number);
  assert.ok(Math.abs(w - (pw - 68)) < 0.01);
  assert.ok(Math.abs(h - (pw - 68) * 0.75) < 0.01);
  assert.equal(x, 34);
  assert.ok(Math.abs(y + h - (ph - 34)) < 0.02);
  const tall = latin1(pdfOfPictures([{ jpeg: JPEG, width: 100, height: 1000 }], { title: 'x', margin: 34 }));
  const [tw, th] = /q ([\d.]+) 0 0 ([\d.]+) /.exec(tall).slice(1).map(Number);
  assert.ok(Math.abs(th - (ph - 68)) < 0.01);
  assert.ok(Math.abs(tw - (ph - 68) / 10) < 0.01);
});
