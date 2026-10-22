// The desktop app (desktop/, for a computer with no internet): it shows these pages and runs the analysis server on
// the same computer, and hands the pages what they may ask of it (desktop/preload.js). Null in a browser and on a
// phone.

export type SavedPdf = { path: string; folder: string; name: string } | { canceled: true };

export type Desktop = {
  apiUrl: string | null; // the analysis server on this computer
  savePdf: (name: string) => Promise<SavedPdf>; // the page as laid out for paper, into the phone's PDF folder
  showFile: (path: string) => Promise<void>; // a saved PDF in the computer's file browser
};

export const desktop: Desktop | null = typeof window !== 'undefined'
  ? ((window as unknown as { theEngineerDesktop?: Desktop }).theEngineerDesktop ?? null)
  : null;
