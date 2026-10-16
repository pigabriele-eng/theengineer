# The Engineer on a computer (offline)

The same pages and analysis as the web app, on one computer with no internet: no sign-in, and nothing on Render,
Supabase or Backblaze. The phone gets the reports as PDFs.

- **Data folder**: picked on first start (default `Documents/The Engineer`). It holds the database
  (`theengineer.db`), the uploaded logs and recordings (`files/`) and the server's log (`app logs/server.log`).
  File › Use another data folder switches to another one (a folder with The Engineer data in it opens that data).
  Keep it out of iCloud Drive, OneDrive and Google Drive: a synced database can break.
- **PDFs for the phone**: "Save PDF for phone" on a page (where the web app has "Print / Save as PDF") saves it, laid
  out for A4 paper, into the phone's folder, picked the first time: a folder that syncs to the phone (iCloud Drive,
  OneDrive or Google Drive). Saving the same page again replaces the older PDF.

## How it works

`main.js` (Electron) starts the analysis server (`server/`, packed as one program by PyInstaller, or in development
the Python next to the code via `server_main.py`) on `127.0.0.1` with `DATABASE_URL` and `STORAGE_DIR` in the data
folder, serves the web build of `app/` on another local port, and shows it. `preload.js` hands the page the server's
address and the PDF saving (`app/lib/desktop.ts`).

## Build and try it

Installers: `.github/workflows/desktop.yml` builds the Mac `.dmg` and Windows `.exe` on GitHub; on `main` they go on
the release *Desktop app (latest)*.

Locally (development):

```bash
cd server && python -m venv .venv && .venv/bin/pip install -e .
cd ../app && npm ci && npx expo export --platform web --output-dir dist
cd ../desktop && npm ci && npm start
```
