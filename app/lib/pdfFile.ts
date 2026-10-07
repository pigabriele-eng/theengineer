// A PDF file of pictures, one A4 page each (lib/pdf.web.ts draws a printed page's pages as JPEG pictures): each
// picture across the page between the paper's margins, from the top margin down. The JPEGs go in as they are (a PDF
// reads JPEG), so nothing is decoded or compressed again here. Tested in pdfFile.test.mjs.

/** An A4 page in points (1/72 inch). */
export const A4_PT: readonly [number, number] = [595.28, 841.89];

/** A page's picture: a baseline JPEG (what a canvas makes) and its size in pixels. */
export type PdfPicture = { jpeg: Uint8Array; width: number; height: number };

/** The PDF of `pages`, `title` in its properties, `margin` points of white paper round each picture. */
export function pdfOfPictures(pages: PdfPicture[], { title, margin, date = new Date() }: {
  title: string; margin: number; date?: Date }): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const put = (x: string | Uint8Array) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    chunks.push(b);
    length += b.length;
  };
  const start = (n: number) => {
    offsets[n] = length;
    put(`${n} 0 obj\n`);
  };
  const num = (x: number) => String(Math.round(x * 100) / 100);

  // objects: 1 catalog, 2 page tree, 3 properties, then a page, its drawing and its picture for each page
  const pageObj = (i: number) => 4 + 3 * i;
  put('%PDF-1.4\n');
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // a comment of high bytes: the file is binary
  start(1);
  put('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  start(2);
  put(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`);
  start(3);
  put(`<< /Title ${pdfText(title)} /Creator ${pdfText('The Engineer')} /CreationDate (${pdfDate(date)}) >>\nendobj\n`);
  const [pw, ph] = A4_PT;
  pages.forEach((p, i) => {
    const n = pageObj(i);
    // across the page between the margins; a picture taller than the room left is made smaller to fit
    let w = pw - 2 * margin;
    let h = (w * p.height) / p.width;
    if (h > ph - 2 * margin) {
      w *= (ph - 2 * margin) / h;
      h = ph - 2 * margin;
    }
    const draw = `q ${num(w)} 0 0 ${num(h)} ${num(margin)} ${num(ph - margin - h)} cm /P Do Q`;
    start(n);
    put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /P ${n + 2} 0 R >> `
      + `/ProcSet [/PDF /ImageC] >> /Contents ${n + 1} 0 R >>\nendobj\n`);
    start(n + 1);
    put(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream\nendobj\n`);
    start(n + 2);
    put(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB `
      + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    put(p.jpeg);
    put('\nendstream\nendobj\n');
  });
  const count = 4 + 3 * pages.length;
  const xref = length;
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// A text in a PDF's properties, any character: UTF-16 with its byte-order mark, in hex
function pdfText(s: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

// D:YYYYMMDDHHmmSSZ, in UTC
function pdfDate(d: Date): string {
  const two = (x: number) => String(x).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}`
    + `${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
}
