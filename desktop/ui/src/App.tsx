// The desktop app's one window: the masthead, the library, the session board and the track map, always all on screen
// (Gabriele, 2026-10-22: "Let's build this version"; the redesign proposal). New logs and videos come in from a folder
// picked once (Import folder) or from the watched folder, where they are, with no upload.
import { useCallback, useEffect, useState } from 'react';

import { bridge, get, post } from './api';
import type { ImportJob, Library as LibraryAnswer, SessionAnswer, TrackMapAnswer } from './api';
import { Board, Pick } from './components/Board';
import { Library } from './components/Library';
import { TrackMap } from './components/TrackMap';

export function App() {
  const [library, setLibrary] = useState<LibraryAnswer | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [title, setTitle] = useState('');
  const [map, setMap] = useState<TrackMapAnswer | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [mapCorner, setMapCorner] = useState<{ code: string; n: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [watching, setWatching] = useState<string | null>(null);

  const refresh = useCallback(() => get<LibraryAnswer>('/desktop/library').then(setLibrary).catch(() => undefined), []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void bridge?.watchFolder?.().then(setWatching); }, []);

  useEffect(() => {
    if (!pick) return;
    setMap(null);
    get<TrackMapAnswer>(`/events/${pick.eventId}/map`).then(setMap).catch(() => setMap(null));
  }, [pick?.eventId]);

  const runImport = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    setStatus('Looking at the files…');
    try {
      const started = await post<{ job: number | null; logs: number; videos: unknown }>('/desktop/import', { paths });
      if (started.job == null) {
        setStatus('Nothing new there: every log is in already');
        await refresh();
        return;
      }
      for (;;) {
        const job = await get<ImportJob>(`/desktop/import/${started.job}`);
        if (job.status === 'done' || job.status === 'failed') {
          const linked = job.videos?.linked.length ?? 0;
          const left = job.videos?.unmatched.length ?? 0;
          setStatus(job.status === 'failed' ? `The import stopped: ${job.message ?? ''}`
            : `Imported ${job.total} log${job.total === 1 ? '' : 's'}${linked ? `, ${linked} video${linked > 1 ? 's' : ''} linked` : ''}`
              + `${left ? `, ${left} video${left > 1 ? 's' : ''} to add by hand` : ''}`);
          setPick(null); // the newest session opens
          await refresh();
          return;
        }
        setStatus(`Importing ${job.done} of ${job.total}${job.current ? `: ${job.current}` : ''}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (e) {
      setStatus(String((e as Error).message));
    }
  }, [refresh]);

  // new files in the watched folder import on their own
  useEffect(() => bridge?.onNewFiles?.((paths) => void runImport(paths)), [runImport]);
  useEffect(() => { if (status) { const t = setTimeout(() => setStatus(null), 9000); return () => clearTimeout(t); } },
    [status]);

  const importFolder = async () => {
    if (bridge?.pickFolders) await runImport(await bridge.pickFolders());
  };

  return (
    <div className="app">
      <header className="masthead">
        <span className="brand">The Engineer</span>
        <nav aria-label="Main"><button aria-current="page">Race weekend</button></nav>
        <span className="spacer" />
        {status && <span className="status" role="status">{status}</span>}
        {bridge?.pickFolders && <button className="btn" onClick={() => void importFolder()}>Import folder</button>}
      </header>
      <div className="body">
        <aside className="rail">
          <div className="lib-head">
            {!bridge?.pickFolders && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void runImport([typed]); }}>
                <input type="text" id="import-path" placeholder="Folder to import" value={typed}
                  onChange={(e) => setTyped(e.target.value)} />
                <button className="btn small" type="submit">Import</button>
              </form>
            )}
            {bridge?.setWatchFolder && (
              <div className="muted" style={{ fontSize: 14 }}>
                {watching ? <>Watching <b>{watching}</b>: new logs and videos there come in on their own. </>
                  : 'Pick a folder to watch and new logs and videos there come in on their own. '}
                <button className="btn small" onClick={async () => setWatching(await bridge!.setWatchFolder!())}>
                  {watching ? 'Change' : 'Watch a folder'}
                </button>
              </div>
            )}
          </div>
          <Library library={library} pick={pick} onPick={(p, t) => { setPick(p); setTitle(t); setActive(null); }} />
        </aside>
        <main className="main">
          {pick ? (
            <Board key={`${pick.eventId}:${pick.part}`} pick={pick} title={title} onSession={(s: SessionAnswer) => void s}
              onActive={setActive} onCursor={setCursor} cursor={cursor} mapCorner={mapCorner} />
          ) : library && !library.tracks.length ? (
            <div className="empty-state">
              <h1>Start with a folder of logs</h1>
              <p className="read">Pick the folder of a race weekend or a test: MoTeC .ld logs, CSV and Pi Toolbox exports,
                VBOX files, and the onboard videos beside them. They are read where they are, nothing is uploaded.</p>
              {bridge?.pickFolders && <button className="btn red" onClick={() => void importFolder()}>Import folder</button>}
            </div>
          ) : <p className="muted">Opening the newest session…</p>}
        </main>
        <aside className="side">
          <div className="eyebrow">{map ? `${title.split(' · ')[0]} · ${(map.length_m / 1000).toFixed(3)} km` : 'Track'}</div>
          <TrackMap map={map} active={active} at={cursor}
            onCorner={(code) => setMapCorner({ code, n: Date.now() })} />
        </aside>
      </div>
    </div>
  );
}
