// "Open a presentation" and "Save presentation" (the session menu, the empty
// slide). Signed in, both pick a repository and browse its folders
// like a file manager. Signed out, Open is just the file picker, and Save
// picks a folder on this computer (or downloads).
//
//   Open:  click a .zip or .pdf to open it.
//   Save:  the folder you're in, a file name, and what to save:
//            <name>.zip                        the presentation (reopens at this slide)
//            <name>.pdf                        the notes PDF
//            <name>-<yyyy-mm-dd>-<hh-mm>.mp4   recordings (or .webm)
//          It starts in the repository and folder the presentation came from.
//
// Beamer+ doesn't impose a layout on the repository: you choose the folder.

import { bus } from '../core/events.js';
import * as GH from '../github/library.js';
import * as F from './folder.js';
import { githubSource, folderSource } from './sources.js';
import { githubActive, toast, updateTitle } from '../github/ui.js';
import { api, appConfig, startSignIn } from '../github/auth.js';
import { setUploadButtonHandler, setDropHandler, chooseLocalFile, openPresentationFile } from '../app/uploader.js';
import { buildPresentationZip } from '../editor/save.js';
import { buildNotesPdf } from '../editor/notes-export.js';
import { openDownloadMenu } from '../editor/download-menu.js';
import { listRecordings, getRecording, updateRecording, formatSize } from '../app/recorder.js';

let appState = null;
const S = {
    repos: null,         // GitHub: the repositories the app can see (cached for the page)
    repo: null,          // GitHub: the repository in use
    src: null,           // the GitHub source in use (see sources.js)
    fsSrc: null,         // the folder on this computer, once chosen
};
const NOTES_KEY = 'beamer.library.notes';
const REPO_KEY = 'beamer.library.repo';        // full name of the last repository
const LOC_KEY = 'beamer.library.where';        // { [source id]: last folder path }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const svg = (d, w = 1.8) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
    gh: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
    up: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    folder: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
    deck: svg('<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/>'),
    pdf: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>'),
    rec: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>'),
    tick: '<svg class="gh-chip-tick" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};
const extOf = name => (/\.([a-z0-9]+)$/i.exec(name || '') || [, ''])[1].toLowerCase();
const baseOf = name => String(name || '').replace(/\.(zip|pdf)$/i, '');
const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const isDeck = name => /\.(zip|pdf)$/i.test(name);
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
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
function recordingPath(t, startedAt, ext) {
    const d = new Date(startedAt), z = n => String(n).padStart(2, '0');
    return join(t.dir, `${t.name}-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}-${z(d.getMinutes())}.${ext}`);
}

/* ─── setup ───────────────────────────────────────────────────── */

export function initLibrary(state) {
    appState = state;
    setUploadButtonHandler(() => { openPresentation(); });
    // Signed in, decks come from GitHub: a dropped file doesn't open by itself.
    setDropHandler((file) => {
        if (!githubActive()) { appState.pendingGhTarget = null; openPresentationFile(file); return; }
        openPresentation();
        toast('Signed in, presentations open from your GitHub repository.');
    });
    bus.on('github:changed', () => { S.src = null; if (!githubActive()) S.repo = null; });
    bus.on('library:open', () => openPresentation());
}

/** The repository or folder in use, for display (or ''). */
export function sourceLabel() {
    if (githubActive()) return S.repo ? S.repo.full_name : (store.get(REPO_KEY) || '');
    return S.fsSrc ? `Folder: ${S.fsSrc.name}` : '';
}

// The source a window uses right now, or null while one still has to be
// chosen. Signed in, a window can use a folder on this computer instead of a
// repository ("A folder on this computer…" in the repository list).
async function source(w) {
    if (githubActive() && !w?.useFolder) {
        if (!S.repo) {
            const name = store.get(REPO_KEY);
            if (name) {
                try { S.repo = (S.repos || []).find(r => r.full_name === name) || await api(`/repos/${name}`); }
                catch { S.repo = null; }
            }
        }
        if (!S.repo) return null;
        if (!S.src || S.src.kind !== 'github' || S.src.repo.full_name !== S.repo.full_name) S.src = githubSource(S.repo);
        return S.src;
    }
    if (!F.supported() || !(await F.remembered()) || (await F.permission()) !== 'granted') return null;
    if (!S.fsSrc) S.fsSrc = folderSource(await F.remembered());
    return S.fsSrc;
}

/* ─── the window ──────────────────────────────────────────────── */

/** Signed in: the repository browser. Signed out: just the file picker
 *  (a .zip or .pdf from this computer). */
export function openPresentation() {
    if (!githubActive()) { appState.pendingGhTarget = null; chooseLocalFile(); return; }
    openWindow('open');
}
export function savePresentation() {
    if (!appState.zipFile) return;
    openWindow('save');
}

function openWindow(mode) {
    const root = document.createElement('div');
    root.className = 'gh-lib';
    root.dataset.mode = mode;
    root.innerHTML = `<div class="gh-lib-src"></div><div class="gh-lib-nav"></div><div class="gh-lib-body"></div><div class="gh-lib-foot"></div>`;
    window.BeamerModal?.show({
        kind: 'info',
        title: mode === 'save' ? 'Save presentation' : 'Open a presentation',
        body: root,
        buttons: [],
    });
    window.BeamerModal?.open?.querySelector('.custom-modal-content')?.classList.add('gh-modal');
    const w = {
        mode, root, cwd: null,
        srcBox: root.querySelector('.gh-lib-src'),
        nav: root.querySelector('.gh-lib-nav'),
        body: root.querySelector('.gh-lib-body'),
        foot: root.querySelector('.gh-lib-foot'),
        name: null,                // save: the file name typed so far
        // A folder on this computer rather than a repository: always when
        // signed out; signed in, when the presentation came from one.
        useFolder: mode === 'save' && (!githubActive() || !!appState.ghTarget?.src?.startsWith('folder:')),
    };
    drawFoot(w);
    refreshWindow(w);
}

async function refreshWindow(w) {
    w.nav.innerHTML = ''; w.body.innerHTML = '';
    try {
        w.srcBox.innerHTML = '';
        if (githubActive()) await drawRepoRow(w);
        if (w.useFolder) await drawFolderRow(w);
        const src = await source(w);
        if (!src) return;
        // A folder on this computer is chosen with the system picker and saved
        // into directly; only repositories are browsed here.
        if (src.kind === 'folder') return drawSaveForm(w, src, '', [], []);
        if (w.cwd === null) {
            const t = appState.ghTarget;
            w.cwd = t && t.src === src.id ? t.dir : lastFolder(src);
        }
        await browse(w, src, w.cwd);
    } catch (e) {
        if (e?.status === 401) {
            w.body.innerHTML = `<p class="gh-err">${esc(e.message)}</p>
                <p><button type="button" class="gh-btn gh-btn--primary" data-in>${ICON.gh}Sign in with GitHub</button></p>`;
            w.body.querySelector('[data-in]').onclick = () => startSignIn({ back: location.pathname }).catch(err => showError('Sign-in', err));
            return;
        }
        w.body.innerHTML = `<p class="gh-err">${esc(e?.message || e)}</p><p><button type="button" class="gh-btn" data-retry>Try again</button></p>`;
        w.body.querySelector('[data-retry]').onclick = () => { S.src?.refresh(); refreshWindow(w); };
    }
}

// Signed out, saving can also just download (no folder needed).
function drawFoot(w) {
    if (githubActive() || w.mode !== 'save') { w.foot.innerHTML = ''; return; }
    w.foot.innerHTML = `<button type="button" class="gh-link" data-download>${ICON.pdf}Download instead</button>`;
    w.foot.querySelector('[data-download]').addEventListener('click', () => { window.BeamerModal?.close(); openDownloadMenu(); });
}

/* Signed in: the repository. */
async function drawRepoRow(w) {
    if (!S.repos) w.srcBox.innerHTML = `<p class="gh-muted">Finding your repositories…</p>`;
    const [repos, cfg] = await Promise.all([S.repos || GH.listRepos(), appConfig()]);
    S.repos = repos;
    if (!S.repo) { const n = store.get(REPO_KEY); S.repo = repos.find(r => r.full_name === n) || null; }
    const install = cfg.app_slug ? `https://github.com/apps/${encodeURIComponent(cfg.app_slug)}/installations/new` : 'https://github.com/settings/installations';
    if (!repos.length) {
        w.srcBox.innerHTML = `<p><b>Beamer+ can’t see any of your repositories yet.</b> On GitHub, give it access to the repository your presentations are in, then check again.</p>
            <p class="gh-row"><a class="gh-btn gh-btn--primary" href="${esc(install)}" target="_blank" rel="noopener">${ICON.gh}Give Beamer+ access</a><button type="button" class="gh-btn" data-again>Check again</button></p>`;
        w.srcBox.querySelector('[data-again]').onclick = () => { S.repos = null; refreshWindow(w); };
        if (w.mode === 'open' || (F.supported() && !w.useFolder)) {
            w.srcBox.insertAdjacentHTML('beforeend', `<p class="gh-row"><button type="button" class="gh-link" data-use-folder>${ICON.folder}${w.mode === 'open' ? 'Open a file from this computer instead' : 'Save to a folder on this computer instead'}</button></p>`);
            w.srcBox.querySelector('[data-use-folder]').onclick = () => { w.useFolder = true; useComputer(w); };
        }
        return;
    }
    const cur = w.useFolder ? '__folder' : (S.repo?.full_name || '');
    // "A file on this computer…" (Open) is the system file picker; "A folder on
    // this computer…" (Save) the system folder picker (Chrome, Edge).
    // "Add another repository…" opens GitHub's page for giving Beamer+ access;
    // the list refreshes when you come back (or with the refresh button).
    w.srcBox.innerHTML = `
        <div class="gh-field"><label for="gh-repo-select">${w.mode === 'save' ? 'Save to' : 'Open from'}</label>
            <div class="gh-repo-row">
                <select id="gh-repo-select" data-repo>${cur ? '' : '<option value="" selected>Choose a repository…</option>'}${repos.map(r => `<option value="${esc(r.full_name)}"${r.full_name === cur ? ' selected' : ''}>${esc(r.full_name)}${r.private ? ' (private)' : ''}</option>`).join('')}
                    ${w.mode === 'open' ? '<option value="__folder">A file on this computer…</option>'
                        : F.supported() ? `<option value="__folder"${cur === '__folder' ? ' selected' : ''}>A folder on this computer…</option>` : ''}
                    <option value="__add">Add another repository…</option></select>
                <button type="button" class="gh-btn gh-icon-btn" data-again title="Refresh the list" aria-label="Refresh the list">${ICON.refresh}</button>
            </div></div>`;
    w.srcBox.querySelector('[data-repo]').onchange = (e) => {
        if (e.target.value === '__add') {
            e.target.value = cur;
            window.open(install, '_blank', 'noopener');
            const back = () => { window.removeEventListener('focus', back); if (document.body.contains(w.root)) { S.repos = null; refreshWindow(w); } };
            window.addEventListener('focus', back);
            return;
        }
        w.cwd = null;
        if (e.target.value === '__folder') {
            if (w.mode === 'open') e.target.value = cur;
            w.useFolder = true; useComputer(w); return;
        }
        w.useFolder = false;
        S.repo = repos.find(r => r.full_name === e.target.value) || null;
        S.src = null;
        store.set(REPO_KEY, S.repo?.full_name || null);
        refreshWindow(w);
    };
    w.srcBox.querySelector('[data-again]').onclick = () => { S.repos = null; refreshWindow(w); };
}

// This computer: Open is the system file picker (a .zip or .pdf); Save is
// the system folder picker, then saves into that folder.
async function useComputer(w) {
    if (w.mode === 'open') {
        window.BeamerModal?.close();
        appState.pendingGhTarget = null;
        chooseLocalFile();
        return;
    }
    try {
        if (await F.choose()) S.fsSrc = null;
        else if (!(await F.remembered())) w.useFolder = false;      // cancelled with nothing chosen
    } catch (e) { showError('Couldn’t open that folder', e); }
    refreshWindow(w);
}

/* Signed out: the folder. */
async function drawFolderRow(w) {
    if (!F.supported()) {
        w.srcBox.insertAdjacentHTML('beforeend', `<p class="gh-note">This browser can’t save into folders (Chrome and Edge can). You can still download the presentation below.</p>`);
        return;
    }
    const h = await F.remembered();
    const perm = await F.permission();
    w.srcBox.insertAdjacentHTML('beforeend', `
        <div class="gh-field gh-folder-field"><span>Folder</span>
            <div class="gh-folder">${ICON.folder}<span class="gh-folder-name">${h ? esc(h.name) : '<span class="gh-muted">No folder chosen</span>'}</span>
                ${h && perm !== 'granted' ? `<button type="button" class="gh-btn gh-btn--primary gh-btn--sm" data-allow>Allow access</button>` : ''}
                <button type="button" class="gh-btn gh-btn--sm${h ? '' : ' gh-btn--primary'}" data-choose>${h ? 'Change…' : 'Choose a folder…'}</button></div></div>`);
    w.srcBox.querySelector('[data-allow]')?.addEventListener('click', async () => { if (await F.reconnect()) { S.fsSrc = null; refreshWindow(w); } });
    w.srcBox.querySelector('[data-choose]').onclick = async () => {
        try { if (await F.choose()) { S.fsSrc = null; w.cwd = null; refreshWindow(w); } }
        catch (e) { showError('Couldn’t open that folder', e); }
    };
}

/* The folder browser: where you are, and what's in it. */
async function browse(w, src, path) {
    w.cwd = path;
    rememberFolder(src, path);
    const parts = path ? path.split('/') : [];
    const rootLabel = src.kind === 'github' ? src.name.split('/')[1] : src.name;
    w.nav.innerHTML = `<nav class="gh-crumbs" aria-label="Folder">
        <button type="button" class="gh-crumb" data-to="">${src.kind === 'github' ? ICON.gh : ICON.folder}<span>${esc(rootLabel)}</span></button>
        ${parts.map((p, i) => `<span class="gh-crumb-sep">›</span><button type="button" class="gh-crumb" data-to="${esc(parts.slice(0, i + 1).join('/'))}"${i === parts.length - 1 ? ' aria-current="location"' : ''}>${esc(p)}</button>`).join('')}
    </nav>`;
    w.nav.querySelectorAll('[data-to]').forEach(b => { b.onclick = () => browse(w, src, b.dataset.to); });
    w.body.innerHTML = `<p class="gh-muted">Reading…</p>`;
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
    const up = path ? `<button type="button" class="gh-item gh-item--up" data-dir="${esc(path.split('/').slice(0, -1).join('/'))}">${ICON.up}<span>..</span></button>` : '';
    const rows = [
        ...dirs.map(d => `<button type="button" class="gh-item gh-item--dir" data-dir="${esc(d.path)}">${ICON.folder}<span>${esc(d.name)}</span></button>`),
        ...files.map((f, i) => `<button type="button" class="gh-item gh-item--file${filesQuiet ? ' is-quiet' : ''}" data-file="${i}">${/\.zip$/i.test(f.name) ? ICON.deck : ICON.pdf}<span>${esc(f.name)}</span>${f.size ? `<small>${formatSize(f.size)}</small>` : ''}</button>`),
    ];
    return `<div class="gh-files">${up}${rows.join('') || '<p class="gh-muted gh-empty">Nothing here yet.</p>'}</div>`;
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
        appState.pendingGhTarget = { src: src.id, dir, name: baseOf(entry.name) };
        window.BeamerModal?.close();
        openPresentationFile(file);
    } catch (e) {
        appState.pendingGhTarget = null;
        window.BeamerModal?.close();
        showError('Couldn’t open it', e);
    }
}

/* Save: this folder, a name, and what to save. */
// The takes a save offers: those recorded with this presentation (or with no
// presentation yet) that aren't saved there already.
async function takesFor(src, key) {
    let recs = [];
    try { recs = await listRecordings(); } catch { /* none */ }
    return recs.filter(r => (r.lecture === key || !r.lecture)
        && !(r.uploaded && r.uploaded.repo === src.id)
        && !(src.limit && (r.size || 0) > src.limit));
}

async function drawSaveForm(w, src, path, dirs, decks) {
    const t0 = appState.ghTarget;
    if (w.name === null) w.name = t0 && t0.src === src.id ? t0.name : (GH.cleanName(appState.deckName) || 'presentation');
    const takes = await takesFor(src, t0 ? targetKey(t0) : null);
    const zips = decks.filter(d => /\.zip$/i.test(d.name));
    w.body.innerHTML = `${src.kind === 'folder' ? '' : listHTML(path, dirs, zips, { filesQuiet: true })}
        <label class="gh-field"><span>File name</span>
            <input data-name value="${esc(w.name)}" spellcheck="false" autocomplete="off"></label>
        <div class="gh-field"><span>Save</span>
            <div class="gh-chips" role="group" aria-label="What to save">
                <label class="gh-chip" title="The presentation: reopens at the slide you're on"><input type="checkbox" data-deck checked><span>${ICON.deck}Presentation${ICON.tick}</span></label>
                <label class="gh-chip" title="One PDF with your annotations and widgets drawn in"><input type="checkbox" data-notes${wantNotes() ? ' checked' : ''}><span>${ICON.pdf}Notes${ICON.tick}</span></label>
                <label class="gh-chip" title="${takes.length ? `${takes.length} recording${takes.length > 1 ? 's' : ''} not saved yet` : 'No recordings to save'}"><input type="checkbox" data-recs${takes.length ? ' checked' : ' disabled'}><span>${ICON.rec}Recordings${takes.length ? ` <small>${takes.length}</small>` : ''}${ICON.tick}</span></label>
            </div></div>
        <p class="gh-err" data-save-err></p>
        <p class="gh-row gh-row--end"><button type="button" class="gh-btn" data-cancel>Cancel</button>
            <button type="button" class="gh-btn gh-btn--primary" data-save>Save</button></p>`;
    const nameIn = w.body.querySelector('[data-name]');
    nameIn.addEventListener('input', () => { w.name = nameIn.value; });
    w.body.querySelectorAll('[data-dir]').forEach(b => { b.onclick = () => browse(w, src, b.dataset.dir); });
    w.body.querySelectorAll('[data-file]').forEach(b => { b.onclick = () => { nameIn.value = baseOf(zips[Number(b.dataset.file)].name); w.name = nameIn.value; }; });
    w.body.querySelector('[data-cancel]').onclick = () => window.BeamerModal?.close();
    w.body.querySelector('[data-save]').onclick = () => {
        const n = GH.cleanName(nameIn.value);
        const err = w.body.querySelector('[data-save-err]');
        if (!n) { err.textContent = 'Name the file first.'; nameIn.focus(); return; }
        const deck = w.body.querySelector('[data-deck]').checked;
        const notes = w.body.querySelector('[data-notes]').checked;
        const recs = w.body.querySelector('[data-recs]').checked ? takes.map(r => r.id) : [];
        if (!deck && !notes && !recs.length) { err.textContent = 'Tick something to save.'; return; }
        try { localStorage.setItem(NOTES_KEY, notes ? '1' : '0'); } catch { /* ignore */ }
        appState.ghTarget = { src: src.id, dir: path, name: n };
        updateTitle();
        window.BeamerModal?.close();
        setTimeout(() => saveNow(src, { deck, notes, recordings: recs }), 0);
    };
    nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') w.body.querySelector('[data-save]').click(); });
    setTimeout(() => nameIn.focus(), 0);
}

let saving = false;
async function saveNow(src, { deck = true, notes, recordings }) {
    const t = appState.ghTarget;
    if (!t || saving) return;
    saving = true;
    document.body.classList.add('gh-saving');
    loading(`Saving to ${src.where}…`, 'Building the presentation…');
    try {
        bus.emit('annotations:flush');
        const files = [];
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
        const saved = [];
        for (const id of recordings) {
            const r = await getRecording(id);
            if (!r || (src.limit && r.blob.size > src.limit)) continue;
            const path = recordingPath(t, r.meta.startedAt, extOf(r.meta.fileName) || 'webm');
            files.push({ path, blob: r.blob });
            saved.push({ id, path });
        }
        await src.write(files, `Beamer+: save ${zipPath(t)}`, setLoading);
        for (const u of saved) await updateRecording(u.id, { uploaded: { repo: src.id, path: u.path, at: Date.now() } });
        window.BeamerModal?.close();
        const extra = [notes && (deck ? 'notes' : 'the notes'), saved.length && `${saved.length} recording${saved.length > 1 ? 's' : ''}`].filter(Boolean);
        toast(`Saved ${deck ? zipPath(t) : `to ${t.dir || src.name}`}${extra.length ? `, with ${extra.join(' and ')}` : ''}.`);
    } catch (e) {
        console.error('[library] save failed', e);
        window.BeamerModal?.close();
        showError('Save failed', e);
    } finally {
        saving = false;
        document.body.classList.remove('gh-saving');
    }
}
