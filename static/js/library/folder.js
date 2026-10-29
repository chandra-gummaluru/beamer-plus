// The computer's own file windows, for Open and Save (library/ui.js):
//   Open:  the system's Open window, showing presentations only (.zip, .pdf);
//          New Session (start page) shows it, then hands the file over.
//   Save:  the system's folder window, to choose where the files go.
// Each starts where you last were (the browser remembers it per window, and
// Save also starts in the folder of the deck you opened or last saved).
//
// Uses the File System Access API (Chrome, Edge). Other browsers: Open is
// the plain file input and Save downloads (supported() is false).

const DB = 'beamer-folder', STORE = 'handles';

export const supported = () => typeof window.showOpenFilePicker === 'function'
    && typeof window.showDirectoryPicker === 'function';

function idb() {
    return new Promise((res) => {
        let req;
        try { req = indexedDB.open(DB, 1); } catch { res(null); return; }
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
    });
}
async function idbGet(key) {
    const db = await idb(); if (!db) return null;
    return new Promise(res => {
        const r = db.transaction(STORE).objectStore(STORE).get(key);
        r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
    });
}
async function idbSet(key, v) {
    const db = await idb(); if (!db) return;
    await new Promise(res => {
        const tx = db.transaction(STORE, 'readwrite');
        if (v) tx.objectStore(STORE).put(v, key); else tx.objectStore(STORE).delete(key);
        tx.oncomplete = res; tx.onerror = res;
    });
}

// The folder last saved into (across sessions), read early so the Save
// click can open the folder window at once.
let lastSave = null;
const ready = idbGet('save-dir').then(h => { lastSave = h; }).catch(() => {});
export const warm = () => ready;

const abort = e => e?.name === 'AbortError';

/** The system's Open window, presentations only. Returns { file, handle }, or null if cancelled. */
export async function pickDeck() {
    let handles;
    try {
        handles = await window.showOpenFilePicker({
            id: 'beamer-open',
            types: [{ description: 'Presentations (PDF or Beamer+ ZIP)', accept: { 'application/pdf': ['.pdf'], 'application/zip': ['.zip'] } }],
            excludeAcceptAllOption: true,
            multiple: false,
        });
    } catch (e) { if (abort(e)) return null; throw e; }
    const handle = handles?.[0];
    return handle ? { file: await handle.getFile(), handle } : null;
}

/** The system's Open window without the File System Access API: a plain
 *  file input. Returns { file, handle: null }, or null if cancelled. */
export function pickDeckPlain() {
    return new Promise((res) => {
        const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.pdf,.zip,application/pdf,application/zip' });
        input.addEventListener('change', () => res(input.files?.[0] ? { file: input.files[0], handle: null } : null));
        input.addEventListener('cancel', () => res(null));
        input.click();
    });
}

/** Hand a chosen file from the start page to the session it starts
 *  (the page changes in between). */
export async function stashOpen(got) {
    // A copy of the bytes: some browsers can't keep a file read from disk in IndexedDB.
    const f = got.file, file = new File([await f.arrayBuffer()], f.name, { type: f.type, lastModified: f.lastModified });
    await idbSet('pending-open', { file, handle: got.handle || null, at: Date.now() });
}
/** The file the start page chose for this session, once (null if none). */
export async function takeOpen() {
    const v = await idbGet('pending-open');
    if (v) await idbSet('pending-open', null);
    return v && Date.now() - v.at < 10 * 60_000 ? v : null;
}

/** The system's folder window, to save in. `near` (a file or folder handle)
 *  is where it starts; else the last folder saved into. Null if cancelled. */
export async function pickSaveFolder(near = null) {
    let dir;
    try {
        dir = await window.showDirectoryPicker({ id: 'beamer-save', mode: 'readwrite', startIn: near || lastSave || 'documents' });
    } catch (e) {
        if (abort(e)) return null;
        // A remembered folder that's gone: start in Documents instead.
        if (e?.name === 'NotFoundError' || e?.name === 'TypeError') {
            try { dir = await window.showDirectoryPicker({ id: 'beamer-save', mode: 'readwrite', startIn: 'documents' }); }
            catch (e2) { if (abort(e2)) return null; throw e2; }
        } else throw e;
    }
    lastSave = dir;
    idbSet('save-dir', dir);
    return dir;
}

/** Which of `names` are already in `dir`. */
export async function existing(dir, names) {
    const out = [];
    for (const n of names) {
        try { await dir.getFileHandle(n); out.push(n); } catch { /* not there */ }
    }
    return out;
}

/** Write files ([{ path, blob }], file names in `dir`). */
export async function write(dir, files, onStep = () => {}) {
    if ((await dir.queryPermission?.({ mode: 'readwrite' })) === 'prompt') await dir.requestPermission({ mode: 'readwrite' });
    const made = [];                                      // new files, removed again if it fails
    try {
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            onStep(`Writing ${f.path}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ''}…`);
            if (!(await existing(dir, [f.path])).length) made.push(f.path);
            const fh = await dir.getFileHandle(f.path, { create: true });
            const w = await fh.createWritable();
            await w.write(f.blob);
            await w.close();
        }
    } catch (e) {
        for (const n of made) { try { await dir.removeEntry(n); } catch { /* leave it */ } }
        throw e;
    }
}
