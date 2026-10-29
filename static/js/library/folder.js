// The computer's own Open window, for Open (library/ui.js): presentations
// only (.zip, .pdf). New Session (start page) shows it, then hands the file
// over. It starts where you last opened from (the browser remembers it).
//
// Uses the File System Access API (Chrome, Edge). Other browsers: the plain
// file input (supported() is false).

const DB = 'beamer-folder', STORE = 'handles';

export const supported = () => typeof window.showOpenFilePicker === 'function';

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
