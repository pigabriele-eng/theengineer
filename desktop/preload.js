// What the pages (desktop/ui/src/api.ts, and the older screens' app/lib/desktop.ts) can ask of the desktop app: where
// the analysis server answers, saving the page as a PDF in the phone's folder, picking folders and videos to import,
// and the watched folder. Nothing else of the computer is open to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('theEngineerDesktop', {
  apiUrl: ipcRenderer.sendSync('te:api-url'),
  savePdf: (name) => ipcRenderer.invoke('te:save-pdf', name),
  showFile: (file) => ipcRenderer.invoke('te:show-file', file),
  pickFolders: () => ipcRenderer.invoke('te:pick-folders'),
  pickVideo: () => ipcRenderer.invoke('te:pick-video'),
  watchFolder: () => ipcRenderer.invoke('te:watch-folder'),
  setWatchFolder: () => ipcRenderer.invoke('te:set-watch-folder'),
  onNewFiles: (cb) => {
    const listener = (_e, paths) => cb(paths);
    ipcRenderer.on('te:new-files', listener);
    return () => ipcRenderer.removeListener('te:new-files', listener);
  },
  openClassic: (where) => ipcRenderer.invoke('te:open-classic', where),
});
