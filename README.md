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

- Create sessions, upload a MoTeC `.ld` file, and see laps, best lap, theoretical best and per-corner metrics (brake point, minimum speed, throttle pickup, full throttle).
- Upload many files at once ("Upload logs or a zip" on the Sessions tab): `.ld` logs with their `.ldx`, CSV exports and `.zip` files, in any mix. Logs can sit in folders at any depth of a zip, and a zip inside a zip is opened too. Each log becomes a session named after the folder that holds it (`01_D1S1`; a second log in that folder is `01_D1S1 (2)`), or after its header or file name when it has no folder of its own; the sessions from one zip share an event named after the zip. Files that aren't logs are skipped and listed. The server imports in the background (`POST /imports`, then `GET /imports/{id}` for progress).
- Lap timing works even when a log has no lap marker: the start/finish line is learned from the first log at a track that has one, and other logs are timed by GPS line crossing (within about 0.03 s of the dash on the Hockenheim test data). Uploading the `.ldx` that i2 saves next to a log uses its beacons instead.
- `server/scripts/event_report.py <folder> <out.json>` summarises a folder of runs from one track: every run's best and theoretical best, corner-by-corner time against the fastest lap, the ideal lap from the best corners of all runs, tyre pressures and temperatures, brake temperatures, ABS and TC activity.
- Compare any lap with the reference lap: running time gained or lost, speed, throttle and brake on one distance axis, with corner markers. Drag across a chart to read both laps at the same point.
- Voice debriefs: record on the iPhone or in the browser (or upload a recording), pick one driver or group and the language (English, Italian, German or mixed). The server transcribes with speaker separation, then Claude sorts each statement into the report sections and tags the corner and phase when they're said. Each point links back to the moment in the recording.
- When a session has logger data, each debrief point about a corner shows what the logger recorded there: brake point, minimum speed, full throttle and section time on the reference lap, and the best lap through that corner.
- Typed debrief points are still available for quick notes.
- Car-specific channel maps: a car can override which logger channels fill speed, throttle, brake and steering (for example brake pressure instead of brake torque).
