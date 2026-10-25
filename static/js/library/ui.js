// "Open a presentation" and "Save presentation". A new session opens with the
// Open window, which stays until a presentation opens (there is no Open
// button); Save comes from Close session. Each browses a folder on this
// computer, like a file manager: Open
// the folder you open presentations from, Save the folder you save them in.
// They're chosen separately (the same folder or not, "Use <the other one>"
// is one click), and each is remembered across sessions, along with the
// subfolder you were last in.
//
//   Open:  click a .zip or .pdf to open it ("Or upload from somewhere else instead"
//          for anything outside the folder).
//   Save:  the folder you're in, a file name, and what to save:
//            <name>.zip                        the presentation (reopens at this slide)
//            <name>.pdf                        the notes PDF
//            <name>-<yyyy-mm-dd>-<hh-mm>.mp4   recordings (or .webm)
//          It starts where the presentation was last saved (or opened from,
//          when that's inside the save folder), else where you last saved.
//          "Or download instead" puts the files in the downloads folder.
//
// Choosing a folder needs the File System Access API (Chrome, Edge). Other
// browsers: Open is the file picker and Save downloads.
//
// Beamer+ doesn't impose a layout on the folder: you choose where things go.

import { bus } from '../core/events.js';
import * as Folder from './folder.js';
import { toast } from '../app/toast.js';
import { setDropHandler, chooseLocalFile, openPresentationFile } from '../app/uploader.js';
import { buildPresentationZip } from '../editor/save.js';
import { buildNotesPdf } from '../editor/notes-export.js';
import { listRecordings, getRecording, updateRecording, downloadRecording, formatSize } from '../app/recorder.js';

let appState = null;

// The chosen folders (folder.js), as the browser below sees them: one for
// Open, one for Save (the same folder or not).
const folderSource = role => ({
    kind: 'folder', id: role, role, where: 'your folder', limit: null,
    get name() { return Folder.rootName(role) || 'your folder'; },
    list: path => Folder.list(role, path),
    read: entry => Folder.read(entry),
    write: (files, _msg, onStep) => Folder.write(role, files, onStep),
    refresh() {},
});
const FOLDERS = { open: folderSource('open'), save: folderSource('save') };
// Where a target lives: Open's folder or Save's.
const roleOf = t => (t?.src === 'save' ? 'save' : t?.src === 'open' ? 'open' : null);
// "Download instead": files go to the browser's downloads folder, one download each.
const COMPUTER = {
    kind: 'computer', id: 'computer', name: 'this computer', where: 'this computer', limit: null,
    async write(files) {
        for (const f of files) {
            const url = URL.createObjectURL(f.blob);
            const a = Object.assign(document.createElement('a'), { href: url, download: f.path.split('/').pop() });
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            await new Promise(r => setTimeout(r, 400));          // so the browser takes each one
        }
    },
    refresh() {},
};
const NOTES_KEY = 'beamer.library.notes';
const LOC_KEY = 'beamer.library.where';        // { open|save: last subfolder browsed there }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const svg = (d, w = 1.8) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
    up: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    folder: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
    deck: svg('<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/>'),
    pdf: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    down: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    rec: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>'),
    tick: '<svg class="lib-chip-tick" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};
const extOf = name => (/\.([a-z0-9]+)$/i.exec(name || '') || [, ''])[1].toLowerCase();
const baseOf = name => String(name || '').replace(/\.(zip|pdf)$/i, '');
const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const isDeck = name => /\.(zip|pdf)$/i.test(name);
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
/** A name that's safe as a file name on any system. */
const cleanName = s => String(s || '').replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
const wantNotes = () => { try { return localStorage.getItem(NOTES_KEY) !== '0'; } catch { return true; } };
const showError = (title, err) => window.BeamerModal?.show({ kind: 'error', title, message: err?.message || String(err) });
const loading = (title, message = '') => window.BeamerModal?.show({ kind: 'loading', title, message });
function setLoading(message) {
    const el = window.BeamerModal?.open?.querySelector('.custom-modal-message');
    if (el) el.textContent = message;
}
const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const lastFolder = (src) => (store.get(LOC_KEY) || {})[src.id] || '';
const rememberFolder = (src, path) => store.set(LOC_KEY, { ...(store.get(LOC_KEY) || {}), [src.id]: path });

/** "<folder>/<name>": what a save of target t is called (recordings are matched to it). */
export const targetKey = t => (t ? join(t.dir, t.name) : null);
const zipPath = t => join(t.dir, `${t.name}.zip`);
const notesPath = t => join(t.dir, `${t.name}.pdf`);
function recordingPath(t, meta, ext) {
    // A take split into parts: all parts carry the take's start time, plus "-part<n>".
    const d = new Date(meta.groupStartedAt || meta.startedAt), z = n => String(n).padStart(2, '0');
    const part = meta.part && (meta.part > 1 || / part 1 /.test(meta.fileName || '')) ? `-part${meta.part}` : '';
    return join(t.dir, `${t.name}-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}-${z(d.getMinutes())}${part}.${ext}`);
}

/* ─── setup ───────────────────────────────────────────────────── */

export function initLibrary(state) {
    appState = state;
    // A file dropped on the window opens as it is (it isn't in the folder).
    setDropHandler((file) => { appState.pendingTarget = null; openPresentationFile(file); });
    bus.on('library:require', requirePresentation);
    bus.on('deck:loaded', () => {
        required = false;
        document.body.classList.remove('lib-required');
        // The Open window may have come back while the deck was loading.
        if (window.BeamerModal?.open?.querySelector('.lib-modal--required')) window.BeamerModal.close();
        updateTitle();
    });
    Folder.remembered('open').catch(() => null);
}

/** The tab's title: the presentation's name. */
function updateTitle() {
    const t = appState?.target;
    const name = t?.name || (appState?.zipFile ? appState.deckName : '');
    document.title = name ? `${name} · Beamer+` : 'Beamer+';
}

/* ─── the window ──────────────────────────────────────────────── */

/** Browse the folder for a presentation (the file picker in browsers that
 *  can't use a folder). */
export function openPresentation() {
    if (!Folder.supported()) { appState.pendingTarget = null; chooseLocalFile(); return; }
    openWindow('open');
}

/* A session with nothing open: the Open window, which can't be closed until
   a presentation has opened. Its other ways in: a file from anywhere else,
   or one dropped on the window. (Close session, top-right, still leaves.) If anything puts
   it away first (the file picker, a file that wouldn't open), it comes back. */
let required = false;
let watching = false;
function requirePresentation() {
    if (appState.zipFile) return;
    required = true;
    openWindow('open');
    if (watching) return;
    watching = true;
    let t = 0;
    new MutationObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => {
            if (required && !appState.zipFile && !window.BeamerModal?.open) openWindow('open');
        }, 500);
    }).observe(document.body, { childList: true });
}
export function savePresentation() {
    if (!appState.zipFile) return;
    openWindow('save');
}

function openWindow(mode) {
    const root = document.createElement('div');
    root.className = 'lib';
    root.dataset.mode = mode;
    root.innerHTML = `<div class="lib-src"></div><div class="lib-nav"></div><div class="lib-body"></div><div class="lib-foot"></div>`;
    const locked = mode === 'open' && required;
    window.BeamerModal?.show({
        kind: 'info',
        title: mode === 'save' ? 'Save Presentation' : 'Open a Presentation',
        body: root,
        buttons: [],
        canClose: locked ? () => !required : null,
    });
    const card = window.BeamerModal?.open?.querySelector('.custom-modal-content');
    card?.classList.add('lib-modal');
    card?.classList.toggle('lib-modal--required', locked);
    // Close session (top-right) stays reachable above it: the way out.
    document.body.classList.toggle('lib-required', locked);
    const w = {
        mode, root, cwd: null,
        srcBox: root.querySelector('.lib-src'),
        nav: root.querySelector('.lib-nav'),
        body: root.querySelector('.lib-body'),
        foot: root.querySelector('.lib-foot'),
        name: null,                // save: the file name typed so far
        // Download rather than save in the folder: when this browser can't
        // use a folder, or the last save was a download.
        local: mode === 'save' && (!Folder.supported() || appState.target?.src === 'computer'),
        locked,
    };
    refreshWindow(w);
}

async function refreshWindow(w) {
    w.nav.innerHTML = ''; w.body.innerHTML = ''; w.srcBox.innerHTML = '';
    drawFoot(w);
    try {
        if (w.mode === 'open' && !Folder.supported()) return drawPickFile(w);
        if (w.local) { drawComputerRow(w); return drawSaveForm(w, COMPUTER, '', [], []); }
        if (!(await drawFolderRow(w))) return;
        const src = FOLDERS[w.mode];
        if (w.cwd === null) w.cwd = await startFolder(w.mode);
        await browse(w, src, w.cwd);
    } catch (e) {
        if (e?.name === 'NotFoundError' && w.cwd) { w.cwd = ''; return refreshWindow(w); }   // that folder is gone
        w.body.innerHTML = `<p class="lib-err">${esc(e?.message || e)}</p><p><button type="button" class="btn" data-retry>Try again</button></p>`;
        w.body.querySelector('[data-retry]').onclick = () => refreshWindow(w);
    }
}

// A browser that can't use a folder: one file, from the file picker.
function drawPickFile(w) {
    w.body.innerHTML = `<p>Choose your presentation: a PDF, or a Beamer+ presentation you saved (a ZIP).
        You can also drop it anywhere on the window.</p>
        <p class="lib-row"><button type="button" class="btn btn--primary" data-pick>${ICON.pdf}Choose a File…</button></p>`;
    w.body.querySelector('[data-pick]').onclick = () => { appState.pendingTarget = null; chooseLocalFile(); };
}

// Underneath: the other way (one file from anywhere, or a download).
function drawFoot(w) {
    if (w.local || (w.mode === 'open' && !Folder.supported())) {
        w.foot.innerHTML = '';
    } else {
        w.foot.innerHTML = w.mode === 'open'
            ? `<button type="button" class="link" data-local>Or upload from somewhere else instead</button>`
            : `<button type="button" class="link" data-local>Or download instead</button>`;
        w.foot.querySelector('[data-local]').onclick = () => {
            // While it has to stay up, the window stays under the file picker.
            if (w.mode === 'open') { if (!w.locked) window.BeamerModal?.close(); appState.pendingTarget = null; chooseLocalFile(); return; }
            w.local = true; w.cwd = null; refreshWindow(w);
        };
    }
}

// Downloading: where it goes, and the way back to the folder.
function drawComputerRow(w) {
    w.srcBox.innerHTML = `<p class="lib-muted lib-small lib-local-note">${ICON.down}Saves to your browser’s downloads folder.
        ${Folder.supported() ? '<button type="button" class="link" data-folder-back>Save in a folder instead</button>' : ''}</p>`;
    w.srcBox.querySelector('[data-folder-back]')?.addEventListener('click', () => { w.local = false; w.cwd = null; refreshWindow(w); });
}

// Where a window starts: in the folder the presentation was last saved to
// or opened from, when that's in this window's folder; otherwise wherever
// you last were in it (remembered across sessions).
async function startFolder(role) {
    const t = appState.target, from = roleOf(t);
    if (from === role || (from && await Folder.same(from, role))) return t.dir;
    return lastFolder(FOLDERS[role]);
}

// This window's folder (Open's or Save's, chosen separately): choose it the
// first time, allow it again (after the browser restarts it asks once), or
// change it. True when it's ready to browse.
async function drawFolderRow(w) {
    const role = w.mode, other = role === 'open' ? 'save' : 'open';
    const had = await Folder.remembered(role);
    const perm = had ? await Folder.permission(role) : 'none';
    const choose = async () => {
        try { if (await Folder.choose(role)) { w.cwd = ''; refreshWindow(w); } }
        catch (e) { showError('Couldn’t use that folder', e); }
    };
    const what = role === 'save' ? 'Save to' : 'Open from';
    if (perm === 'granted') {
        w.srcBox.innerHTML = `<div class="lib-folder"><span class="lib-folder-what">${what}</span>${ICON.folder}<span class="lib-folder-name"></span>
            <button type="button" class="link" data-change>Change folder…</button></div>`;
        w.srcBox.querySelector('.lib-folder-name').textContent = Folder.rootName(role);
        w.srcBox.querySelector('[data-change]').onclick = choose;
        return true;
    }
    if (had) {
        w.body.innerHTML = `<p>Beamer+ needs your OK to ${role === 'save' ? 'save in' : 'open from'} <b></b> again.</p>
            <p class="lib-row"><button type="button" class="btn btn--primary" data-allow>${ICON.folder}Allow access</button>
            <button type="button" class="btn" data-choose>Choose another folder…</button></p>`;
        w.body.querySelector('b').textContent = Folder.rootName(role);
        w.body.querySelector('[data-allow]').onclick = async () => { if (await Folder.reconnect(role)) refreshWindow(w); };
        w.body.querySelector('[data-choose]').onclick = choose;
        return false;
    }
    // Nothing chosen for this window yet. The other window's folder is one click away.
    const otherName = (await Folder.remembered(other)) ? Folder.rootName(other) : '';
    w.body.innerHTML = role === 'save'
        ? `<p>Choose the folder to save presentations in. Beamer+ remembers it for next time
            (it can be a different folder from the one you open them from).</p>`
        : `<p>Choose the folder your presentations are in (your course folder, say).
            Beamer+ remembers it for next time.</p>`;
    w.body.insertAdjacentHTML('beforeend', `<p class="lib-row"><button type="button" class="btn btn--primary" data-choose>${ICON.folder}Choose a folder…</button>
        ${otherName ? `<button type="button" class="btn" data-adopt></button>` : ''}</p>`);
    w.body.querySelector('[data-choose]').onclick = choose;
    const adopt = w.body.querySelector('[data-adopt]');
    if (adopt) {
        adopt.textContent = `Use ${otherName}`;
        adopt.title = `The folder you ${other === 'open' ? 'open presentations from' : 'save presentations in'}`;
        adopt.onclick = async () => {
            if (await Folder.adopt(role, other)) {
                if ((await Folder.permission(role)) !== 'granted') await Folder.reconnect(role);
                w.cwd = null; refreshWindow(w);
            }
        };
    }
    return false;
}

/* The folder browser: where you are, and what's in it. */
async function browse(w, src, path) {
    w.cwd = path;
    rememberFolder(src, path);
    const parts = path ? path.split('/') : [];
    const rootLabel = src.name;
    w.nav.innerHTML = `<nav class="lib-crumbs" aria-label="Folder">
        <button type="button" class="lib-crumb" data-to="">${ICON.folder}<span>${esc(rootLabel)}</span></button>
        ${parts.map((p, i) => `<span class="lib-crumb-sep">›</span><button type="button" class="lib-crumb" data-to="${esc(parts.slice(0, i + 1).join('/'))}"${i === parts.length - 1 ? ' aria-current="location"' : ''}>${esc(p)}</button>`).join('')}
    </nav>`;
    w.nav.querySelectorAll('[data-to]').forEach(b => { b.onclick = () => browse(w, src, b.dataset.to); });
    w.body.innerHTML = `<p class="lib-muted">Reading…</p>`;
    let items = [];
    try { items = await src.list(path); }
    catch (e) { if (e?.name !== 'NotFoundError' && e?.name !== 'TypeMismatchError') throw e; }   // a folder made in this window, not saved yet
    if (w.cwd !== path) return;                                       // moved on meanwhile
    const dirs = items.filter(x => x.type === 'dir' && !x.name.startsWith('.')).sort(byName);
    const decks = items.filter(x => x.type === 'file' && isDeck(x.name)).sort(byName);
    if (w.mode === 'open') drawOpenList(w, src, path, dirs, decks);
    else drawSaveForm(w, src, path, dirs, decks);
}

function listHTML(path, dirs, files, { filesQuiet = false } = {}) {
    const up = path ? `<button type="button" class="lib-item lib-item--up" data-dir="${esc(path.split('/').slice(0, -1).join('/'))}">${ICON.up}<span>..</span></button>` : '';
    const rows = [
        ...dirs.map(d => `<button type="button" class="lib-item lib-item--dir" data-dir="${esc(d.path)}">${ICON.folder}<span>${esc(d.name)}</span></button>`),
        ...files.map((f, i) => `<button type="button" class="lib-item lib-item--file${filesQuiet ? ' is-quiet' : ''}" data-file="${i}">${/\.zip$/i.test(f.name) ? ICON.deck : ICON.pdf}<span>${esc(f.name)}</span>${f.size ? `<small>${formatSize(f.size)}</small>` : ''}</button>`),
    ];
    return `<div class="lib-files">${up}${rows.join('') || '<p class="lib-muted lib-empty">Nothing here yet.</p>'}</div>`;
}

/* Open: folders and presentations (.zip, .pdf). */
function drawOpenList(w, src, path, dirs, decks) {
    w.body.innerHTML = listHTML(path, dirs, decks);
    w.body.querySelectorAll('[data-dir]').forEach(b => { b.onclick = () => browse(w, src, b.dataset.dir); });
    w.body.querySelectorAll('[data-file]').forEach(b => { b.onclick = () => openDeck(src, decks[Number(b.dataset.file)]); });
}

async function openDeck(src, entry) {
    loading('Opening…', `${entry.name}: reading from ${src.where}`);
    try {
        const bytes = await src.read(entry);
        const isPdf = extOf(entry.name) === 'pdf';
        const file = new File([bytes], entry.name, { type: isPdf ? 'application/pdf' : 'application/zip' });
        const dir = entry.path.split('/').slice(0, -1).join('/');
        appState.pendingTarget = { src: src.id, dir, name: baseOf(entry.name) };
        window.BeamerModal?.close();
        openPresentationFile(file);
    } catch (e) {
        appState.pendingTarget = null;
        window.BeamerModal?.close();
        showError('Couldn’t open it', e);
    }
}

/* Save: this folder, a name, and what to save. */
// The takes a save offers: those recorded with this presentation (or with no
// presentation yet) that aren't saved there already. Takes too big for the
// destination (made before recordings were split into parts) come back
// separately, so the window can offer to download them instead of hiding them.
async function takesFor(src, key) {
    let recs = [];
    try { recs = await listRecordings(); } catch { /* none */ }
    const mine = recs.filter(r => (r.lecture === key || !r.lecture)
        && !r.uploaded)
        .sort((a, b) => a.startedAt - b.startedAt);
    const fits = r => !(src.limit && (r.size || 0) > src.limit);
    return { takes: mine.filter(fits), tooBig: mine.filter(r => !fits(r)) };
}

async function drawSaveForm(w, src, path, dirs, decks) {
    const t0 = appState.target;
    if (w.name === null) w.name = t0?.name || cleanName(appState.deckName) || 'presentation';
    const { takes, tooBig } = await takesFor(src, t0 ? targetKey(t0) : null);
    const zips = decks.filter(d => /\.zip$/i.test(d.name));
    w.body.innerHTML = `${src.kind === 'computer' ? '' : listHTML(path, dirs, zips, { filesQuiet: true })}
        <label class="lib-field"><span>File name</span>
            <input data-name value="${esc(w.name)}" spellcheck="false" autocomplete="off"></label>
        <div class="lib-field"><span>Save</span>
            <div class="lib-chips" role="group" aria-label="What to save">
                <label class="lib-chip" title="The presentation: reopens at the slide you're on"><input type="checkbox" data-deck checked><span>${ICON.deck}Presentation${ICON.tick}</span></label>
                <label class="lib-chip" title="One PDF with your annotations and widgets drawn in"><input type="checkbox" data-notes${wantNotes() ? ' checked' : ''}><span>${ICON.pdf}Notes${ICON.tick}</span></label>
                <label class="lib-chip" title="${takes.length ? `${takes.length} recording${takes.length > 1 ? 's' : ''} not saved yet` : 'No recordings to save'}"><input type="checkbox" data-recs${takes.length ? ' checked' : ' disabled'}><span>${ICON.rec}Recordings${takes.length ? ` <small>${takes.length}</small>` : ''}${ICON.tick}</span></label>
            </div></div>
        ${tooBig.length ? `<p class="lib-muted lib-small lib-toobig">${tooBig.length === 1 ? '1 recording is' : `${tooBig.length} recordings are`} too big to save here.
            <button type="button" class="link" data-toobig>Download ${tooBig.length === 1 ? 'it' : 'them'} instead</button></p>` : ''}
        <p class="lib-err" data-save-err></p>
        <p class="lib-row lib-row--end"><button type="button" class="btn" data-cancel>Cancel</button>
            <button type="button" class="btn btn--primary" data-save>Save</button></p>`;
    const nameIn = w.body.querySelector('[data-name]');
    nameIn.addEventListener('input', () => { w.name = nameIn.value; });
    w.body.querySelectorAll('[data-dir]').forEach(b => { b.onclick = () => browse(w, src, b.dataset.dir); });
    w.body.querySelectorAll('[data-file]').forEach(b => { b.onclick = () => { nameIn.value = baseOf(zips[Number(b.dataset.file)].name); w.name = nameIn.value; }; });
    w.body.querySelector('[data-cancel]').onclick = () => window.BeamerModal?.close();
    w.body.querySelector('[data-toobig]')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        for (const r of tooBig) { await downloadRecording(r.id); await new Promise(res => setTimeout(res, 700)); }
        e.currentTarget.disabled = false;
    });
    w.body.querySelector('[data-save]').onclick = () => {
        const n = cleanName(nameIn.value);
        const err = w.body.querySelector('[data-save-err]');
        if (!n) { err.textContent = 'Name the file first.'; nameIn.focus(); return; }
        const deck = w.body.querySelector('[data-deck]').checked;
        const notes = w.body.querySelector('[data-notes]').checked;
        const recs = w.body.querySelector('[data-recs]').checked ? takes.map(r => r.id) : [];
        if (!deck && !notes && !recs.length) { err.textContent = 'Tick something to save.'; return; }
        try { localStorage.setItem(NOTES_KEY, notes ? '1' : '0'); } catch { /* ignore */ }
        appState.target = { src: src.id, dir: path, name: n };
        updateTitle();
        window.BeamerModal?.close();
        setTimeout(() => saveNow(src, { deck, notes, recordings: recs }), 0);
    };
    nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') w.body.querySelector('[data-save]').click(); });
    setTimeout(() => nameIn.focus(), 0);
}

let saving = false;
async function saveNow(src, { deck = true, notes, recordings }) {
    const t = appState.target;
    if (!t || saving) return;
    saving = true;
    document.body.classList.add('lib-saving');
    loading(`Saving to ${src.where}…`, 'Building the presentation…');
    const files = [], saved = [];
    try {
        bus.emit('annotations:flush');
        if (deck) {
            const zip = await buildPresentationZip({
                extra: { 'config/resume.json': JSON.stringify({ slide: appState.currentSlide, savedAt: new Date().toISOString() }) },
            });
            files.push({ path: zipPath(t), blob: zip });
        }
        if (notes) {
            setLoading('Building the notes PDF…');
            files.push({ path: notesPath(t), blob: await buildNotesPdf() });
        }
        for (const id of recordings) {
            const r = await getRecording(id);
            if (!r || (src.limit && r.blob.size > src.limit)) continue;
            const path = recordingPath(t, r.meta, extOf(r.meta.fileName) || 'webm');
            files.push({ path, blob: r.blob });
            saved.push({ id, path });
        }
    } catch (e) {
        console.error('[library] save failed', e);
        window.BeamerModal?.close();
        showError('Save failed', e);
        saving = false;
        document.body.classList.remove('lib-saving');
        return;
    }
    await writeOut(src, t, files, saved, { deck, notes });
}

// Write what saveNow built. If it fails, nothing is lost (recordings stay in
// Beamer+ until deleted): offer to try again or to download instead.
async function writeOut(src, t, files, saved, { deck, notes }) {
    saving = true;
    document.body.classList.add('lib-saving');
    loading(`Saving to ${src.where}…`, '');
    try {
        await src.write(files, `save ${zipPath(t)}`, setLoading);
        if (src.kind !== 'computer') {
            for (const u of saved) await updateRecording(u.id, { uploaded: { repo: src.id, path: u.path, at: Date.now() } });
        }
        window.BeamerModal?.close();
        const extra = [notes && (deck ? 'notes' : 'the notes'), saved.length && `${saved.length} recording${saved.length > 1 ? 's' : ''}`].filter(Boolean);
        toast(src.kind === 'computer'
            ? `Downloaded${extra.length ? `, with ${extra.join(' and ')}` : ''}.`
            : `Saved ${deck ? join(src.name, zipPath(t)) : `in ${join(src.name, t.dir)}`}${extra.length ? `, with ${extra.join(' and ')}` : ''}.`);
        bus.emit('library:saved', { target: t });
    } catch (e) {
        console.error('[library] save failed', e);
        const kept = saved.length ? ' Your recordings stay in Beamer+, ready for the next save.' : '';
        const buttons = [
            { label: 'Close', kind: 'cancel' },
            { label: 'Try again', kind: src.kind === 'computer' ? 'ok' : 'cancel', onClick: () => setTimeout(() => writeOut(src, t, files, saved, { deck, notes }), 0) },
        ];
        if (src.kind !== 'computer') {
            buttons.push({ label: 'Download instead', kind: 'ok', onClick: () => setTimeout(() => writeOut(COMPUTER, t, files, saved, { deck, notes }), 0) });
        }
        window.BeamerModal?.show({
            kind: 'error',
            title: `Couldn’t save to ${src.where}`,
            message: `${e?.message || String(e)}${kept}`,
            buttons,
        });
    } finally {
        saving = false;
        document.body.classList.remove('lib-saving');
    }
}
