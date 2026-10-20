// A folder on this computer to browse for presentations and save them in,
// when signed out of GitHub (the folder plays the repository's part).
//
// Uses the File System Access API (Chrome, Edge). The chosen folder is
// remembered in this browser (IndexedDB); after a reload the browser asks
// once to allow access again.

const DB = 'beamer-folder', STORE = 'handles', KEY = 'root';

export const supported = () => typeof window.showDirectoryPicker === 'function';

function idb() {
    return new Promise((res) => {
        let req;
        try { req = indexedDB.open(DB, 1); } catch { res(null); return; }
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
    });
}
async function idbGet() {
    const db = await idb(); if (!db) return null;
    return new Promise(res => {
        const r = db.transaction(STORE).objectStore(STORE).get(KEY);
        r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
    });
}
async function idbSet(v) {
    const db = await idb(); if (!db) return;
    await new Promise(res => {
        const tx = db.transaction(STORE, 'readwrite');
        if (v) tx.objectStore(STORE).put(v, KEY); else tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = res; tx.onerror = res;
    });
}

let root = null;        // FileSystemDirectoryHandle

/** The remembered folder, if any (permission may still be needed). */
export async function remembered() {
    if (!root) root = await idbGet();
    return root;
}
/** 'granted', 'prompt' or 'denied' for the remembered folder. */
export async function permission() {
    if (!root) return 'none';
    try { return await root.queryPermission({ mode: 'readwrite' }); } catch { return 'denied'; }
}
/** Ask to use the remembered folder again (needs a click). */
export async function reconnect() {
    if (!root) return false;
    try { return (await root.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch { return false; }
}
/** Choose a folder (needs a click). Returns false if cancelled. */
export async function choose() {
    let h;
    // Browsers don't let a page into your home folder by itself: the system
    // picker opens (in Documents the first time, then wherever you last
    // were), and the folder you choose is remembered.
    try { h = await window.showDirectoryPicker({ id: 'beamer-library', mode: 'readwrite', startIn: 'documents' }); }
    catch (e) { if (e?.name === 'AbortError') return false; throw e; }
    root = h;
    await idbSet(h);
    return true;
}

const isDir = h => h.kind === 'directory';

async function dirAt(path, create = false) {
    let d = root;
    for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p, { create });
    return d;
}

/** What's in a folder (path '' is the chosen folder): [{ name, path, type: 'dir'|'file', handle }]. */
export async function list(path) {
    const d = await dirAt(path);
    const out = [];
    for await (const [name, h] of d.entries()) {
        if (name.startsWith('.')) continue;
        out.push({ name, path: path ? `${path}/${name}` : name, type: isDir(h) ? 'dir' : 'file', handle: h });
    }
    return out;
}

export async function read(entry) { return (await entry.handle.getFile()).arrayBuffer(); }
export async function changed(entry) { try { return new Date((await entry.handle.getFile()).lastModified); } catch { return null; } }

/** Write files ([{ path, blob }], paths from the chosen folder), making folders as needed. */
export async function write(files, onStep = () => {}) {
    for (let i = 0; i < files.length; i++) {
        const f = files[i], parts = f.path.split('/');
        onStep(`Writing ${parts[parts.length - 1]}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ''}…`);
        const d = await dirAt(parts.slice(0, -1).join('/'), true);
        const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
        const w = await fh.createWritable();
        await w.write(f.blob);
        await w.close();
    }
}
