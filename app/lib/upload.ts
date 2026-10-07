// An upload of logs, sent with its progress: fetch can't say how much of a request has gone out, XMLHttpRequest can
// (xhr.upload.onprogress, on the web and in React Native). The same POST /imports as eventsApi.importInto, then the
// import job is followed with api.importJob as before.
import { API_URL, ImportJob } from '@/lib/api';
import { accessToken, authEnabled, signOut } from '@/lib/auth';

export type PickedFile = { uri: string; name: string; file?: File | Blob; mimeType?: string; size?: number | null };

/** How much of the upload has gone out: bytes sent of the request's total (the files and the form around them). */
export type Sent = { loaded: number; total: number };

// On web we have a File or Blob; on iOS and Android FormData takes a { uri, name, type } descriptor.
const formFile = (f: PickedFile, type: string) =>
  f.file ? (f.file instanceof File ? f.file : new File([f.file], f.name, { type: f.file.type || type }))
    : ({ uri: f.uri, name: f.name, type } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

/** The files' size in bytes, as far as it is known before sending (a picked file on a phone may not say). */
export const sizeOf = (files: PickedFile[]) =>
  files.reduce((n, f) => n + (f.file ? f.file.size : f.size ?? 0), 0);

/** Send the files into an event (or, with null, a new event per zip) and hand back the import job the server made;
 * `onSent` hears how much has gone out as it goes. */
export async function sendImport(files: PickedFile[], eventId: number | null, onSent: (s: Sent) => void): Promise<ImportJob> {
  const form = new FormData();
  for (const f of files) {
    const part = formFile(f, f.mimeType || 'application/octet-stream');
    if (f.file) form.append('files', part, f.name);
    else form.append('files', part);
  }
  if (eventId != null) form.append('event_id', String(eventId));
  const token = await accessToken();
  const guess = sizeOf(files);

  const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let total = guess;
    xhr.open('POST', `${API_URL}/imports`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total) total = e.total;
      onSent({ loaded: e.loaded, total });
    };
    xhr.upload.onload = () => onSent({ loaded: total || 1, total: total || 1 }); // all of it has gone out
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new Error('The upload was cut off: check the connection and try again.'));
    xhr.ontimeout = () => reject(new Error('The upload took too long: try fewer files at a time.'));
    xhr.send(form);
  });

  if (res.status === 401 && authEnabled) await signOut('Your session has ended. Please sign in again.');
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    // not JSON: an error page from a proxy
  }
  if (res.status < 200 || res.status >= 300) {
    const detail = (body as { detail?: unknown } | null)?.detail;
    throw new Error(typeof detail === 'string' ? detail : `Upload failed (${res.status})`);
  }
  return body as ImportJob;
}
