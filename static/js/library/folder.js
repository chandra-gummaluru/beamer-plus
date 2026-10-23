// The folders on this computer that Open and Save browse (library/ui.js):
// one to open presentations from ('open') and one to save them into
// ('save'). They can be the same folder or different ones; each is chosen
// once and remembered in this browser across sessions (IndexedDB). After the
// browser restarts it asks once to allow access again (Chrome's "Allow on
// every visit" skips that).
//
// Uses the File System Access API (Chrome, Edge).

const DB = 'beamer-folder', STORE = 'handles';
export const ROLES = ['open', 'save'];

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

const roots = { open: null, save: null };     // FileSystemDirectoryHandle per role
let loaded = null;

// Read both from IndexedDB once. A folder remembered before Open and Save
// had their own ('root') becomes both.
function load() {
    return (loaded ||= (async () => {
        const [o, s, old] = await Promise.all([idbGet('open'), idbGet('save'), idbGet('root')]);
        roots.open = o || old || null;
        roots.save = s || old || null;
        if (old && !o) await idbSet('open', old);
        if (old && !s) await idbSet('save', old);
        if (old) await idbSet('root', null);
    })());
}

/** The remembered folder for `role`, if any (permission may still be needed). */
export async function remembered(role) {
    await load();
    return roots[role] || null;
}
/** Its name ('' if none). */
export const rootName = role => roots[role]?.name || '';
/** 'granted', 'prompt', 'denied', or 'none' when no folder is remembered. */
export async function permission(role) {
    await load();
    const h = roots[role];
    if (!h) return 'none';
    try { return await h.queryPermission({ mode: 'readwrite' }); } catch { return 'denied'; }
}
/** Ask to use the remembered folder again (needs a click). */
export async function reconnect(role) {
    await load();
    const h = roots[role];
    if (!h) return false;
    try { return (await h.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch { return false; }
}
/** Choose the folder for `role` (needs a click). Returns false if cancelled. */
export async function choose(role) {
    await load();
    let h;
    // Browsers don't let a page into your home folder by itself: the system
    // picker opens (in Documents the first time, then wherever you last
    // chose a folder for this role).
    try { h = await window.showDirectoryPicker({ id: `beamer-${role}`, mode: 'readwrite', startIn: roots[role] || 'documents' }); }
    catch (e) { if (e?.name === 'AbortError') return false; throw e; }
    roots[role] = h;
    await idbSet(role, h);
    return true;
}
/** Use the folder of role `from` for `role` too. */
export async function adopt(role, from) {
    await load();
    if (!roots[from]) return false;
    roots[role] = roots[from];
    await idbSet(role, roots[from]);
    return true;
}
/** Are both roles the same folder? */
export async function same(a, b) {
    await load();
    if (!roots[a] || !roots[b]) return false;
    try { return await roots[a].isSameEntry(roots[b]); } catch { return false; }
}

const isDir = h => h.kind === 'directory';

async function dirAt(role, path, create = false) {
    let d = roots[role];
    if (!d) throw new Error('Choose a folder first.');
    for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p, { create });
    return d;
}

/** What's in a folder of `role` (path '' is the chosen folder): [{ name, path, type: 'dir'|'file', handle }]. */
export async function list(role, path) {
    const d = await dirAt(role, path);
    const out = [];
    for await (const [name, h] of d.entries()) {
        if (name.startsWith('.')) continue;
        out.push({ name, path: path ? `${path}/${name}` : name, type: isDir(h) ? 'dir' : 'file', handle: h });
    }
    return out;
}

export async function read(entry) { return (await entry.handle.getFile()).arrayBuffer(); }
export async function changed(entry) { try { return new Date((await entry.handle.getFile()).lastModified); } catch { return null; } }

/** Write files ([{ path, blob }], paths from the `role` folder), making folders as needed. */
export async function write(role, files, onStep = () => {}) {
    for (let i = 0; i < files.length; i++) {
        const f = files[i], parts = f.path.split('/');
        onStep(`Writing ${parts[parts.length - 1]}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ''}…`);
        const d = await dirAt(role, parts.slice(0, -1).join('/'), true);
        const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
        const w = await fh.createWritable();
        await w.write(f.blob);
        await w.close();
    }
}
