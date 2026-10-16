// The Engineer on a computer, with no internet: this window shows the same app as the web (app/, built for the web),
// and the same analysis server (server/) runs beside it on this computer only. Everything it keeps (the database,
// the logs, what it works out) lives in one data folder the driver picks; nothing goes to Render, Supabase or
// Backblaze. "Save PDF for phone" on a page writes the page as a PDF into a second folder: one that syncs to the phone
// (iCloud Drive, OneDrive, Google Drive) puts the reports on it with no server in between.
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell, systemPreferences } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const APP_NAME = 'The Engineer';

// ---------- settings: which folders (kept with the computer's app settings, not in the data folder) ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(next) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}

let settings = {};

// ---------- the data folder ----------

const defaultDataFolder = () => path.join(app.getPath('documents'), APP_NAME);

// Folders kept in step with other computers or the phone: the database must not be in one (two copies written at once
// break it), the reports should be.
function syncedFolders() {
  const home = os.homedir();
  const found = [];
  const add = (label, dir) => {
    if (dir && fs.existsSync(dir)) found.push({ label, dir });
  };
  if (process.platform === 'darwin') add('iCloud Drive', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  add('OneDrive', process.env.OneDrive || process.env.OneDriveConsumer);
  try {
    const cloud = path.join(home, 'Library', 'CloudStorage'); // Google Drive, Dropbox, OneDrive on a Mac
    for (const name of fs.readdirSync(cloud)) {
      const label = name.startsWith('GoogleDrive') ? 'Google Drive' : name.startsWith('Dropbox') ? 'Dropbox'
        : name.startsWith('OneDrive') ? 'OneDrive' : null;
      if (!label) continue;
      const myDrive = path.join(cloud, name, 'My Drive');
      add(label, fs.existsSync(myDrive) ? myDrive : path.join(cloud, name));
    }
  } catch {
    // no CloudStorage folder: nothing of that kind
  }
  add('Google Drive', process.platform === 'win32' ? 'G:\\My Drive' : null);
  return found;
}

const inSyncedFolder = (dir) => syncedFolders().some((s) => path.resolve(dir).startsWith(path.resolve(s.dir)));

async function askDataFolder(first) {
  const suggested = defaultDataFolder();
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: APP_NAME,
    message: first ? 'Where should The Engineer keep your data?' : 'Move to another data folder?',
    detail: (first ? 'Your logs, runs, debriefs and everything the app works out are kept in one folder on this computer. '
      : 'The app will use the folder you pick from now on; the data in the current folder stays where it is. '
        + 'Pick a folder that already holds The Engineer data to open it. ')
      + 'Keep it out of iCloud Drive, OneDrive and Google Drive: the database breaks if it is synced.',
    buttons: [`Use Documents › ${APP_NAME}`, 'Choose a folder…', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 2) return null;
  if (response === 0) return suggested;
  const picked = await dialog.showOpenDialog({
    title: 'Choose the data folder',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const dir = picked.filePaths[0];
  if (inSyncedFolder(dir)) {
    const { response: go } = await dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message: 'That folder is synced to the internet.',
      detail: 'The database can break when a sync service copies it while the app writes to it. A folder that is not synced is safer.',
      buttons: ['Pick another', 'Use it anyway'],
      defaultId: 0,
      cancelId: 0,
    });
    if (go === 0) return askDataFolder(first);
  }
  return dir;
}

// ---------- the reports folder (the phone's) ----------

async function askReportsFolder() {
  const synced = syncedFolders();
  const choices = synced.map((s) => ({ label: `${s.label} › ${APP_NAME} reports`, dir: path.join(s.dir, `${APP_NAME} reports`) }));
  const buttons = [...choices.map((c) => c.label), 'Choose a folder…', 'Cancel'];
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: APP_NAME,
    message: 'Where should the PDFs for your phone go?',
    detail: 'Pick a folder that syncs to your phone (iCloud Drive, OneDrive or Google Drive): every PDF saved there opens in the '
      + 'Files app or the Drive app on the phone. You can change it later in the File menu.',
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (response === buttons.length - 1) return null;
  if (response < choices.length) return choices[response].dir;
  const picked = await dialog.showOpenDialog({
    title: 'Choose the folder for the phone’s PDFs',
    defaultPath: synced[0]?.dir ?? app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return picked.canceled ? null : picked.filePaths[0] ?? null;
}

// ---------- the analysis server ----------

let server = null; // the running server process
let apiUrl = null;
let webUrl = null;
let quitting = false;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

// The packaged server (PyInstaller, in the app's resources), or in development the Python next to the code.
function serverCommand() {
  if (app.isPackaged) {
    const exe = process.platform === 'win32' ? 'theengineer-server.exe' : 'theengineer-server';
    return { cmd: path.join(process.resourcesPath, 'server', exe), args: [], cwd: path.join(process.resourcesPath, 'server') };
  }
  const repo = path.resolve(__dirname, '..');
  const venv = path.join(repo, 'server', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return {
    cmd: process.env.TE_PYTHON || (fs.existsSync(venv) ? venv : 'python3'),
    args: [path.join(__dirname, 'server_main.py')],
    cwd: path.join(repo, 'server'),
  };
}

async function startServer(dataFolder) {
  fs.mkdirSync(path.join(dataFolder, 'files'), { recursive: true });
  fs.mkdirSync(path.join(dataFolder, 'app logs'), { recursive: true });
  const port = await freePort();
  const { cmd, args, cwd } = serverCommand();
  const log = fs.openSync(path.join(dataFolder, 'app logs', 'server.log'), 'a');
  const env = { ...process.env };
  // nothing online: only this computer's database and folder
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'S3_ENDPOINT', 'S3_BUCKET',
    'S3_KEY_ID', 'S3_SECRET_KEY', 'ALLOWED_EMAILS', 'STORAGE_LIMIT_MB']) delete env[key];
  Object.assign(env, {
    TE_PORT: String(port),
    DATABASE_URL: `sqlite:///${path.join(dataFolder, 'theengineer.db').replace(/\\/g, '/')}`,
    STORAGE_DIR: path.join(dataFolder, 'files'),
    PYTHONPATH: app.isPackaged ? '' : cwd,
    PYTHONUNBUFFERED: '1',
  });
  if (settings.deepgramKey) env.DEEPGRAM_API_KEY = settings.deepgramKey;
  server = spawn(cmd, args, { cwd, env, stdio: ['ignore', log, log], windowsHide: true });
  const proc = server;
  proc.on('exit', (code) => {
    if (server === proc) server = null;
    if (!quitting && code !== 0 && code !== null) {
      dialog.showErrorBox(APP_NAME, `The analysis part of the app stopped (code ${code}). Its log is in the data folder, `
        + `“app logs/server.log”. Close the app and open it again.`);
    }
  });
  apiUrl = `http://127.0.0.1:${port}`;
  // ready once it answers (the first start makes the database; a big data folder takes a few seconds more)
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    if (!server) throw new Error('The analysis part of the app could not start. See “app logs/server.log” in the data folder.');
    try {
      const res = await fetch(`${apiUrl}/health`);
      if (res.ok) return;
    } catch {
      // not answering yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('The analysis part of the app took too long to start.');
}

function stopServer() {
  const proc = server;
  server = null;
  if (proc && proc.exitCode === null) proc.kill();
}

// ---------- the app's pages (the web build of app/) ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.webp': 'image/webp', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

const webFolder = () => (app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '..', 'app', 'dist'));

// Every address that isn't a file is the app's one page, which shows the page the address names (as Render does).
async function startWeb() {
  const root = webFolder();
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`The app’s pages are missing (${root}). In development, build them first: cd app && npx expo export --platform web`);
  }
  const port = await freePort();
  const web = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => web.listen(port, '127.0.0.1', resolve));
  webUrl = `http://127.0.0.1:${port}`;
}

// ---------- the window ----------

let win = null;

const STARTING = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8">
<title>${APP_NAME}</title><style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
background:#F2EEE3;color:#1d1b17;font:600 20px system-ui,sans-serif}@media (prefers-color-scheme:dark){body{background:#151412;color:#eee}}
</style><body>Starting The Engineer…</body>`)}`;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 760, // the computer layout (the app's phone layout starts below 760 px)
    title: APP_NAME,
    backgroundColor: '#F2EEE3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // links to other sites open in the computer's browser (they need the internet; the app doesn't)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(webUrl)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (webUrl && !url.startsWith(webUrl) && !url.startsWith('data:')) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

async function openApp() {
  if (!win) createWindow();
  await win.loadURL(STARTING);
  try {
    stopServer();
    await startServer(settings.dataFolder);
    if (!webUrl) await startWeb();
    await win.loadURL(webUrl);
  } catch (e) {
    dialog.showErrorBox(APP_NAME, String(e?.message ?? e));
  }
}

// The server's address, which the page asks for (preload.js) before the app's script runs
ipcMain.on('te:api-url', (event) => {
  event.returnValue = apiUrl;
});

// ---------- PDFs for the phone ----------

const fileName = (name) => `${String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || APP_NAME}.pdf`;

// The page as it is laid out for paper (the app does that first: lib/print.ts), as an A4 PDF in the phone's folder.
// A PDF of the same page made again replaces the older one, so the phone keeps the newest.
ipcMain.handle('te:save-pdf', async (event, name) => {
  if (!settings.reportsFolder) {
    const dir = await askReportsFolder();
    if (!dir) return { canceled: true };
    settings = { ...settings, reportsFolder: dir };
    writeSettings(settings);
  }
  fs.mkdirSync(settings.reportsFolder, { recursive: true });
  // the paper's margins take the window's colour: white for the PDF
  const owner = BrowserWindow.fromWebContents(event.sender);
  const colour = owner?.getBackgroundColor();
  owner?.setBackgroundColor('#FFFFFF');
  let data;
  try {
    data = await event.sender.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.47, bottom: 0.47, left: 0.47, right: 0.47 }, // 12 mm, as the printed page (lib/print.ts)
    });
  } finally {
    if (colour) owner?.setBackgroundColor(colour);
  }
  const file = path.join(settings.reportsFolder, fileName(name));
  fs.writeFileSync(file, data);
  return { path: file, folder: settings.reportsFolder, name: path.basename(file) };
});

ipcMain.handle('te:show-file', (_e, file) => {
  if (typeof file === 'string' && settings.reportsFolder && path.resolve(file).startsWith(path.resolve(settings.reportsFolder))) {
    shell.showItemInFolder(file);
  }
});

// ---------- the menu ----------

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open the data folder', click: () => shell.openPath(settings.dataFolder) },
        {
          label: 'Use another data folder…',
          click: async () => {
            const dir = await askDataFolder(false);
            if (!dir || dir === settings.dataFolder) return;
            settings = { ...settings, dataFolder: dir };
            writeSettings(settings);
            await openApp();
          },
        },
        { type: 'separator' },
        {
          label: 'Open the phone’s PDF folder',
          enabled: true,
          click: async () => {
            if (!settings.reportsFolder) {
              const dir = await askReportsFolder();
              if (!dir) return;
              settings = { ...settings, reportsFolder: dir };
              writeSettings(settings);
            }
            fs.mkdirSync(settings.reportsFolder, { recursive: true });
            void shell.openPath(settings.reportsFolder);
          },
        },
        {
          label: 'Change the phone’s PDF folder…',
          click: async () => {
            const dir = await askReportsFolder();
            if (!dir) return;
            settings = { ...settings, reportsFolder: dir };
            writeSettings(settings);
          },
        },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- starting and stopping ----------

if (!app.requestSingleInstanceLock()) {
  app.quit(); // one copy at a time: two would write to one database
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setName(APP_NAME);
    // the microphone, for debriefs recorded on the computer; nothing else is asked for
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(['media', 'clipboard-sanitized-write'].includes(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'clipboard-sanitized-write'].includes(permission));
    if (process.platform === 'darwin') void systemPreferences.askForMediaAccess('microphone').catch(() => false);

    settings = readSettings();
    if (!settings.dataFolder) {
      const dir = await askDataFolder(true);
      if (!dir) {
        app.quit();
        return;
      }
      settings = { ...settings, dataFolder: dir };
      writeSettings(settings);
    }
    buildMenu();
    await openApp();
  });

  app.on('activate', () => {
    if (!win && settings.dataFolder) void openApp();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopServer();
  });
}
