// A box on the web page to drop logger files, zips and whole folders on, dragged from Finder or Explorer; clicking
// it opens the file picker instead. On phones there is nothing to drag from: the caller keeps its button there.
// A dropped folder is opened down to its last file, and each file is handed on with its path from the dropped
// folder down ("02_ADACGT4_T01_HOC/01_D1S1/a.ld"): the server groups a folder's logs by that path, as it would a
// zip of the folder. Files of other kinds are left out, with a short note naming what the box takes.
// In the programme's look: a square box in a heavy ink frame with the headline face, filled in ink while files are
// dragged over it; while an upload is under way it shows how far it has got (`progress`) in place of the words.
import { ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View as RNView } from 'react-native';

import { useWide } from '@/components/Programme';
import { Text } from '@/components/Themed';
import { Fonts, themed, Type, useTheme } from '@/constants/Theme';

export type Dropped = { file: File; path: string };

const TAKES = 'MoTeC .ld logs with their .ldx, CSV exports (.csv, .txt), zips of them, or folders holding them';
const hidden = (name: string) => name.startsWith('.') || name === '__MACOSX'; // .DS_Store, Mac resource forks

export function DropZone({ accept, onFiles, onPick, busy, title, action, hint, minHeight, progress }: {
  accept: string[]; // file name endings taken, lower case with the dot: ['.ld', '.zip', ...]
  onFiles: (files: Dropped[]) => void;
  onPick: () => void; // a click: the file picker
  busy?: boolean; // an upload is under way: drops wait for it
  title: string; // the headline: "Drop logs, zips or folders here"
  action?: string; // the underlined words under it: "or click to pick them"
  hint?: string;
  minHeight?: number; // taller than the usual box (the Upload page fills the screen with it)
  progress?: ReactNode; // shown in the box while busy (else a spinner)
}) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const box = useRef<RNView>(null);
  const [over, setOver] = useState(false); // files are being dragged over the box
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null);
  const latest = useRef({ accept, onFiles, busy });
  latest.current = { accept, onFiles, busy };

  useEffect(() => {
    const el = box.current as unknown as HTMLElement | null;
    if (!el || typeof window === 'undefined') return;
    let depth = 0; // dragenter/dragleave also fire on the box's children
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setOver(true);
    };
    const overBox = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // without it the browser won't drop here
      if (e.dataTransfer) e.dataTransfer.dropEffect = latest.current.busy ? 'none' : 'copy';
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      if (latest.current.busy) {
        setNote({ text: 'Wait for this upload to finish, then drop the files again.', warn: true });
        return;
      }
      // the dropped items can only be read during the event itself: take them now, open folders after
      const taken = itemsOf(e.dataTransfer);
      setNote({ text: 'Reading what was dropped…', warn: false });
      filesOf(taken).then(
        (files) => {
          const { accept: ok, onFiles: send } = latest.current;
          const kept = files.filter((f) => ok.some((ext) => f.file.name.toLowerCase().endsWith(ext)));
          const left = files.filter((f) => !kept.includes(f)).map((f) => f.file.name);
          if (!kept.length) {
            const what = left.length === 1 ? ` in ${left[0]}` : left.length ? ` in these ${left.length} files` : '';
            setNote({ text: `Nothing to upload${what}. Drop ${TAKES}.`, warn: true });
            return;
          }
          setNote(left.length ? { text: `Left out ${leftOut(left)}: not logs or zips.`, warn: false } : null);
          send(kept);
        },
        (err: Error) => setNote({ text: `Couldn't read what was dropped: ${err.message}`, warn: true }),
      );
    };
    // a drop just outside the box would open the file in the tab, leaving the app: refused instead (unless
    // something else on the page takes it)
    const outside = (e: DragEvent) => {
      if (!hasFiles(e) || e.defaultPrevented || el.contains(e.target as Node)) return;
      e.preventDefault();
      if (e.dataTransfer && e.type === 'dragover') e.dataTransfer.dropEffect = 'none';
    };
    el.addEventListener('dragenter', enter);
    el.addEventListener('dragover', overBox);
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', drop);
    window.addEventListener('dragover', outside);
    window.addEventListener('drop', outside);
    return () => {
      el.removeEventListener('dragenter', enter);
      el.removeEventListener('dragover', overBox);
      el.removeEventListener('dragleave', leave);
      el.removeEventListener('drop', drop);
      window.removeEventListener('dragover', outside);
      window.removeEventListener('drop', outside);
    };
  }, []);

  return (
    <RNView ref={box} style={styles.wrap}>
      <Pressable onPress={() => { setNote(null); onPick(); }} disabled={busy} accessibilityRole="button"
        accessibilityLabel={`${title}${action ? `, ${action}` : ''}`}
        style={StyleSheet.flatten([styles.zone, busy && progress ? styles.zoneBusy : null,
          minHeight != null && { minHeight }, over && styles.over])}>
        {busy ? (
          progress ?? <ActivityIndicator color={c.text} />
        ) : (
          <>
            <Text style={StyleSheet.flatten([wide ? styles.title : styles.titlePhone, over && styles.onInk])}>
              {over ? 'Drop to upload' : title}
            </Text>
            {action && !over ? <Text style={styles.action}>{action}</Text> : null}
            {hint ? <Text style={StyleSheet.flatten([styles.hint, over && styles.onInk])}>{hint}</Text> : null}
          </>
        )}
      </Pressable>
      {note && <Text style={note.warn ? styles.warn : styles.note}>{note.text}</Text>}
    </RNView>
  );
}

// "5 files (.bmo)", "photo.png", "3 files (.bmo, .pdf)"
function leftOut(names: string[]) {
  if (names.length === 1) return names[0];
  const kinds = [...new Set(names.map((n) => (n.includes('.') ? n.slice(n.lastIndexOf('.')).toLowerCase() : n)))];
  return `${names.length} files (${kinds.slice(0, 4).join(', ')}${kinds.length > 4 ? ', …' : ''})`;
}

// What was dropped: a file system entry per item where the browser gives one (folders need it), else the file.
function itemsOf(dt: DataTransfer): (FileSystemEntry | File)[] {
  const out: (FileSystemEntry | File)[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    const file = entry ? null : item.getAsFile();
    if (entry) out.push(entry);
    else if (file) out.push(file);
  }
  return out.length || !dt.files?.length ? out : Array.from(dt.files);
}

// Every file, folders opened at any depth, each with its path from what was dropped down. Hidden files and folders
// (.DS_Store, __MACOSX) are passed over.
async function filesOf(items: (FileSystemEntry | File)[]): Promise<Dropped[]> {
  const all = await Promise.all(items.map((it) => (it instanceof File ? [{ file: it, path: it.name }] : walk(it))));
  return all.flat().filter((f) => !f.path.split('/').some(hidden));
}

async function walk(entry: FileSystemEntry): Promise<Dropped[]> {
  if (hidden(entry.name)) return [];
  const path = entry.fullPath.replace(/^\/+/, '') || entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
    return [{ file, path }];
  }
  if (!entry.isDirectory) return [];
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (;;) { // a folder's entries come in batches (100 at a time in Chrome) until an empty one
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map(walk))).flat();
}

const useStyles = themed((c) => ({
  wrap: { gap: 8 },
  // three times the first box's height (Gabriele asked for a bigger target)
  zone: { borderWidth: 3, borderColor: c.rule, paddingVertical: 40, paddingHorizontal: 20, alignItems: 'center',
    justifyContent: 'center', gap: 14, minHeight: 252 },
  zoneBusy: { alignItems: 'stretch' },
  over: { backgroundColor: c.rule },
  title: { fontFamily: Fonts.display, fontSize: 44, lineHeight: 46, textTransform: 'uppercase', textAlign: 'center',
    color: c.text, maxWidth: 760 },
  titlePhone: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 33, textTransform: 'uppercase', textAlign: 'center',
    color: c.text },
  action: { ...Type.link, color: c.text, borderBottomWidth: 2, borderColor: c.mark, paddingBottom: 1 },
  hint: { fontFamily: Type.dek.fontFamily, fontSize: 16, lineHeight: 22, color: c.textSecondary, textAlign: 'center' },
  onInk: { color: c.background },
  note: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: c.textSecondary },
  warn: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: c.warning },
}));
