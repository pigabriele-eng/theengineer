# The Engineer

One app for racing drivers and coaches: voice debriefs after every run and logger data analysis (MoTeC now; WinDarab and VBOX next) in one shared session history.

Concept: https://claude.ai/code/artifact/90becf93-0498-4a90-b39b-036fb85adf76

## Layout

| Folder | What it is |
| --- | --- |
| `server/` | Python API (FastAPI): shared data model, native MoTeC `.ld` import, lap splitting, corner detection and corner metrics |
| `app/` | One Expo (React Native) codebase that runs as the iPhone app and as the web app |

## Run it locally

Server (Python 3.11+):

```bash
cd server
pip install -e ".[dev]"
uvicorn app.main:app --reload        # http://localhost:8000, API docs at /docs
pytest                               # tests use synthetic .ld files, no real data needed
```

Voice debriefs need two keys in the server's environment:

| Variable | What it's for | Where to get it |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Structuring the transcript into report points (Claude) | console.anthropic.com, API Keys |
| `DEEPGRAM_API_KEY` | Speech to text with speaker separation | console.deepgram.com, API Keys |

Without them, recordings are still saved, and the report screen offers to process them again once the keys are set.

By default the server uses SQLite (`theengineer.db`) and stores uploads in `./storage`, and sign-in is off. Set `DATABASE_URL` (for example a PostgreSQL URL) and `STORAGE_DIR` to change that. To run the tests against Postgres, point `TEST_DATABASE_URL` at an empty throwaway database (its tables are dropped before each test).

App:

```bash
cd app
npm install
npm run web                          # browser
npm run ios                          # iPhone simulator (macOS), or scan the QR code with Expo Go
```

The app talks to `http://localhost:8000` unless `EXPO_PUBLIC_API_URL` is set. On a real iPhone, set it to your computer's address on the same network.

Sign-in is off unless `EXPO_PUBLIC_SUPABASE_URL` is set. With it (and `EXPO_PUBLIC_SUPABASE_ANON_KEY`), the app shows an email and password sign-in screen, and sends the Supabase access token with every server request. Users are created in the Supabase dashboard; there is no sign-up in the app.

## Deploying

Supabase holds the database, the uploaded files and the logins; Render runs the API server and serves the web app. Both have free plans. [`render.yaml`](render.yaml) describes both Render services as a Blueprint.

Both services deploy the `live` branch, which [`nightly-deploy.yml`](.github/workflows/nightly-deploy.yml) moves to `main` once a night (00:30 UTC), so merges go live together with one restart a day. For a fix that can't wait: GitHub → Actions → *Nightly deploy* → *Run workflow*.

1. **Supabase**: create a project in a European region (Render runs the API in Frankfurt). In Authentication, turn off *Allow new users to sign up*, then add each person under Authentication → Users → *Add user*. Supabase checks the logins; the server only accepts a valid Supabase token on every request (except `/health`).
2. **Render**: New → Blueprint, pick this repository, and fill in the values below when asked. `EXPO_PUBLIC_API_URL` is the API's own address, so if you don't know it yet, finish once, copy it from the `theengineer-api` page, set it on `theengineer-web` and deploy that again.
3. **Supabase again**: Authentication → URL Configuration → *Site URL*: the web app's address (for example `https://theengineer-web.onrender.com`), so emails such as password resets link to it.

API server (`theengineer-api`):

| Variable | What it is | Where it comes from |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string | Supabase → **Connect** (top of the project page) → *Session pooler*: `postgresql://postgres.<ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres`. Put the database password in place of `[YOUR-PASSWORD]` (the Database settings can reset it); percent-encode `@ : / ? #` if it has any. |
| `SUPABASE_URL` | The project's API address, `https://<ref>.supabase.co` | Supabase → **Connect** |
| `SUPABASE_ANON_KEY` | Public key the server sends with each token check | Project Settings → **API Keys**: the publishable key (`sb_publishable_...`), or the legacy `anon` key |
| `SUPABASE_SERVICE_ROLE_KEY` | Private key for file storage; server only, never in the app | Project Settings → **API Keys**: a secret key (`sb_secret_...`), or the legacy `service_role` key |
| `STORAGE_BUCKET` | Storage bucket for logs and recordings (set to `logs`); created private on first start | – |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_KEY_ID`, `S3_SECRET_KEY` | Optional: store new logs in Backblaze B2 (free 10 GB) instead of Supabase Storage (1 GB). Files stored earlier stay in Supabase and are still read from there. If B2 can't be reached on start, the server logs why and keeps using Supabase | Backblaze → **Buckets** (a private bucket; its *Endpoint* is `s3.<region>.backblazeb2.com`) and **Application Keys** (a key for that bucket: *keyID* and *applicationKey*) |
| `STORAGE_DIR`, `STORAGE_CACHE_GB` | Optional: with a Render disk mounted (say at `/var/data`), set `STORAGE_DIR` to it so downloaded logs outlive restarts, and `STORAGE_CACHE_GB` to how much of it they may fill (default 2) | – |
| `STORAGE_LIMIT_MB` | Optional: how much the storage holds (default 1024 on Supabase, 9500 on B2; 0 for no limit). Logs stop being stored 50 MB short of it | – |
| `ALLOWED_EMAILS` | Optional, comma-separated: only these accounts get in | – |
| `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY` | Voice debriefs, as above | console.anthropic.com, console.deepgram.com |

Web app (`theengineer-web`), built into the site at build time (change them, then deploy the site again):

| Variable | Value |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | The API's address, e.g. `https://theengineer-api.onrender.com` (the app adds `https://` if it's left out) |
| `EXPO_PUBLIC_SUPABASE_URL` | Same as `SUPABASE_URL` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Same as `SUPABASE_ANON_KEY` (the public one, never the secret key) |

Why the session pooler: Supabase's direct connection is IPv6 only on the free plan and Render connects over IPv4, and Supabase recommends the session pooler for a long-running server on IPv4. The transaction pooler (port 6543) also works, since the server turns prepared statements off, but it is meant for serverless functions.

Good to know:

- The tables are created on the first start. There are no migrations yet: adding or changing a column on a table that already has data needs an `ALTER TABLE` (or a migration tool) at that point. The server switches on row level security for its tables, so Supabase's Data API, which anyone with the public key could call, sees nothing; the server itself connects as their owner.
- Logs are stored gzip-compressed in Supabase Storage (a 90 MB MoTeC log is about 11 MB), which keeps them under the free plan's 50 MB per-file limit. The server keeps the files it reads in a local cache; Render's disk is emptied on every deploy and restart, so the first read after one downloads again.
- Render's free plan has 512 MB of memory and sleeps after a while without requests (the first request then takes about a minute). Uploading or analysing one 90 MB Hockenheim log peaks at about 250–320 MB, insights over three of them together at about 370 MB; two such requests at the same time add up. An import of many files works through its logs one at a time: the 93 MB Hockenheim test zip (15 logs, 770 MB unpacked) peaked at about 285 MB.
- An import runs in a thread of the server process. If the server restarts during one (a deploy, or Render putting it to sleep after 15 minutes without requests), the import is marked failed and the files have to be uploaded again; the runs imported until then stay.
- Free Supabase projects are paused after a period of inactivity; restore them from the Supabase dashboard.

## What works now

- Create sessions, upload a MoTeC `.ld` file, and see laps, best lap, theoretical best and per-corner metrics (brake point, minimum speed, throttle pickup, full throttle). Corners carry the track's official numbers, grouped the same way as in the insights (for example "T8/T9", or "T2-T5" at Hockenheim). A track without official corner positions gets C1, C2… in lap order instead, with a note saying they are not official numbers.
- Upload many files at once ("Upload logs or a zip" on the Sessions tab): `.ld` logs with their `.ldx`, CSV exports and `.zip` files, in any mix. Logs can sit in folders at any depth of a zip, and a zip inside a zip is opened too. Each log becomes a session named after the folder that holds it (`01_D1S1`; a second log in that folder is `01_D1S1 (2)`), or after its header or file name when it has no folder of its own; the sessions from one zip share an event named after the zip. Files that aren't logs are skipped and listed. The server imports in the background (`POST /imports`, then `GET /imports/{id}` for progress).
- Past / Current / Upcoming on the Sessions tab: an event is current from the day before its first day (travel, setup) to its last. Planned events (＋ New event with a venue, or from the racing calendar) wait under Upcoming with no data; a log recorded at a planned event's venue on one of its days, or the day before, goes into it when uploaded (`server/app/plans.py`). The racing calendar (Tools › Racing calendar) is a Google Calendar read through its secret iCal address, no Google developer setup: the server keeps the address (never shown back in full, never logged), reads it now and then and on Sync now, and keeps each calendar entry's planned event in step by its UID (moves, renames unless renamed in the app, deletions of events with no data). Each entry can be switched off, which keeps it out of later syncs (`server/app/calendar_sync.py`, `server/app/ics.py`, `server/app/routers/planned.py`).
- Lap timing works even when a log has no lap marker: the start/finish line is learned from the logs at a track, and logs without the dash's S/F marker are timed by GPS line crossing (within about 0.03 s of the dash on the Hockenheim test data). The dash's marker is the best source of the line: `.ldx` beacons are used only until a log with the marker comes (i2's "Auto GPS" beacons sat 38 m past the dash's line at Hockenheim and missed laps). When the line moves, the track's other logs are re-timed in the background, one at a time, and the server checks every track the same way when it starts. Every session shows the track it was driven at (from its event, else the log header); a single upload joins the event named in its log header.
- Runs with no laps aren't kept: a log from the pit lane or the garage, or an out-lap and in-lap with no full lap between them, is left out of an import and listed with the reason ("no laps: 52 s in the pit lane"), and a single upload of one is refused with it. A log of a car that did laps it can't time (no start/finish marker, no `.ldx` beacons and no known start/finish line; told from the GPS track passing the same points lap after lap, or the distance at racing speed against the track's length) is kept, and its session says the lap beacon is missing and what fixes it; it is timed by itself once the track's line is learned. Imported runs with no laps already on the server are removed once in the background at startup, with their stored file and cached results, unless the user put something on them (a debrief, setup sheet, driver, car, conditions or tyre).
- `server/scripts/event_report.py <folder> <out.json>` summarises a folder of runs from one track: every run's best and theoretical best, corner-by-corner time against the fastest lap, the ideal lap from the best corners of all runs, tyre pressures and temperatures, brake temperatures, ABS and TC activity.
- Compare any lap with the reference lap: running time gained or lost, speed, throttle and brake on one distance axis, with corner markers. Drag across a chart to read both laps at the same point.
- Compare laps across sessions and drivers ("Compare laps" on the Sessions tab, or "Compare with other sessions and drivers" on a session): pick 2 to 6 laps from any sessions at one track (each session comes in with its best lap; any lap can be swapped in), plus an optional ideal lap made of the quickest section of each. First, where the time is: for the lap in focus, the sections where another lap was quicker, with the seconds, the phase (braking, entry, mid-corner, exit, full throttle) and what was done differently there in plain words (brake point, minimum speed, throttle pick-up, full throttle, grip used, coasting). Then the section times on the official corner numbers, and the running time gap, speed, throttle, brake, steering and gear of every lap on one distance axis with one crosshair; tap a section to zoom in. The laps are placed on one GPS line, and the server reads the logs one at a time and keeps only the picked laps (`POST /compare/laps`; six laps from six of the longest Hockenheim logs peak at about 295 MB).
- Voice debriefs: record on the iPhone or in the browser (or upload a recording), pick one driver or group and the language (English, Italian, German or mixed). The server transcribes with speaker separation, then Claude sorts each statement into the report sections and tags the corner and phase when they're said. Each point links back to the moment in the recording.
- When a session has logger data, each debrief point about a corner shows what the logger recorded there: brake point, minimum speed, full throttle and section time on the reference lap, and the best lap through that corner.
- Typed debrief points are still available for quick notes.
- Car-specific channel maps: a car can override which logger channels fill speed, throttle, brake and steering (for example brake pressure instead of brake torque).
- Tyre model from every log of a car (Tools, Tyre fit, "All data for this car"): each log is summarised once in the background (per lap and axle: slip angle by grip level, TPMS temperature and hot pressure, laps on the tyre; table `tyre_data`), and one model is fitted from all sessions of the car and tyre, optionally for one track or an ambient range. It says first where the grip peaks and which hot pressure and TPMS temperature give the most grip, with how many laps and sessions that rests on and how sure it is. A session can be given another tyre so tyres stay apart. `GET /tyre-model/cars`, `GET /tyre-model?car=...`.
- Technique check ("Technique check" on a session or on a report): one clean lap's driving mistakes against perfect driving (the lap's own line at the car's limits as the whole event shows them), most costly first. Each says where (official corner number or section, and metres), the phase, what the driver did against perfect driving with the numbers (brake point, braking g against the car's, coasting, minimum speed against the grip, full throttle, lifts), what to do instead, and the time it costs against the realistic target (the car at 95% of its grip). The costs add up to the gap to the perfect lap, with the perfect lap's optimism, the places the pedals were already at the limit and what no mistake explains shown apart. Below: the mistakes that repeat across the session's and the event's clean laps (how often, average cost a lap), the mistakes on the track map and the lap's speed against perfect driving's. Every clean lap of an event is checked once in the background from the report's compact traces (`GET /technique/sessions/{id}?lap=N`, `GET /technique/events/{id}`).
