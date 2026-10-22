# The Engineer on a computer (offline)

The Windows app: it reads logs and onboard videos where they are on the computer, and the phone gets the reports as
PDFs. No sign-in, nothing on Render, Supabase or Backblaze (the redesign of 2026-10-22).

- **Screens** (`ui/`, React + Vite): the library of tracks, events and sessions down the left; the **session board**
  (the quickest lap, the combined or stint theoretical, the three corners where the time is in plain words with what
  each is worth, every lap section by section); the **corner view** (two laps, both onboards locked by distance, the
  traces, what to do); the track map always on the right. Stint and Quali still open in the older screens (`app/`,
  in a window of their own) until they move.
- **Import folder** reads the logs in a folder where they are (MoTeC .ld with .ldx, CSV and Pi Toolbox exports,
  VBOX .vbo, zips) and links the videos beside them. **Watch a folder**: files that arrive there come in on their own,
  once they stop growing. A log read from the same place before is skipped.
- **Videos** stay where they are. Each is put on its run's clock by the VBOX Video clock, the camera's own GPS speed
  (GoPro GPMF) matched to the log's, or, by hand, the frame where the car crosses the start/finish line
  (`server/app/videos.py`).
- **Data folder**: picked on first start (default `Documents/The Engineer`). It holds the database
  (`theengineer.db`), a copy of each imported log (`files/`) and the server's log (`app logs/server.log`).
  Keep it out of iCloud Drive, OneDrive and Google Drive: a synced database can break.
- **PDFs for the phone**: "Save PDF for phone" saves the board, laid out for A4, into the phone's folder (one that
  syncs to it: OneDrive, Google Drive, iCloud Drive). Saving the same page again replaces the older PDF.

## How it works

`main.js` (Electron) starts the analysis server (`server/`, packed as one program by PyInstaller, or in development
the Python next to the code via `server_main.py`) on `127.0.0.1` with `DATABASE_URL` and `STORAGE_DIR` in the data
folder, serves `ui/dist` on another local port and shows it. `preload.js` hands the page the server's address, the
PDF saving, the folder and video pickers and the watched folder (`ui/src/api.ts`). The server's desktop-only routes
are `server/app/routers/desktop.py`.

## Build and try it

Installers: `.github/workflows/desktop.yml` builds the Windows `.exe` on GitHub; on `main` it goes on the release
*Desktop app (latest)*.

Locally (development):

```bash
cd server && python -m venv .venv && .venv/bin/pip install -e .
cd ../app && npm ci && npx expo export --platform web --output-dir dist   # the older screens
cd ../desktop/ui && npm ci && npm test && npm run build
cd .. && npm ci && npm start
```

`cd desktop/ui && npm run dev` serves the screens alone against a server already running on 127.0.0.1:8765.
