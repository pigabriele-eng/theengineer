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

By default the server uses SQLite (`theengineer.db`) and stores uploads in `./storage`. Set `DATABASE_URL` (for example a PostgreSQL URL) and `STORAGE_DIR` to change that.

App:

```bash
cd app
npm install
npm run web                          # browser
npm run ios                          # iPhone simulator (macOS), or scan the QR code with Expo Go
```

The app talks to `http://localhost:8000` unless `EXPO_PUBLIC_API_URL` is set. On a real iPhone, set it to your computer's address on the same network.

## What works now

- Create sessions, upload a MoTeC `.ld` file, and see laps, best lap, theoretical best and per-corner metrics (brake point, minimum speed, throttle pickup, full throttle).
- Typed debrief points saved against a session, using the standard GT report sections. Voice recording and AI structuring are the next step.
- Car-specific channel maps: a car can override which logger channels fill speed, throttle, brake and steering (for example brake pressure instead of brake torque).
