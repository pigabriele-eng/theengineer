// The PDF the Print button makes in the browser (lib/pdf.web.ts), on iOS and Android: those apps have no Print
// button, so nothing is ever made here.

export type PdfState =
  | { step: 'idle' }
  | { step: 'making'; owner: string }
  | { step: 'ready'; owner: string; file: File }
  | { step: 'failed'; owner: string; message: string };

export const pdfInstead = false;

const IDLE: PdfState = { step: 'idle' };

export function usePdfState(): PdfState {
  return IDLE;
}

export function makePdf(_name: string, _owner: string) {}

export function sharePdf() {}

export function closePdf() {}
