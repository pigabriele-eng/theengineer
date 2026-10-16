// What the app's pages (app/lib/desktop.ts) can ask of the desktop app: where the analysis server answers, and saving
// the page as a PDF in the phone's folder. Nothing else of the computer is open to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('theEngineerDesktop', {
  apiUrl: ipcRenderer.sendSync('te:api-url'),
  savePdf: (name) => ipcRenderer.invoke('te:save-pdf', name),
  showFile: (file) => ipcRenderer.invoke('te:show-file', file),
});
