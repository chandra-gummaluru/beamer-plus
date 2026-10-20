// "Open a presentation" and "Save presentation" (the session menu, the empty
// slide, Ctrl/⌘+S). Signed in, both pick a repository and browse its folders
// like a file manager. Signed out, Open is just the file picker, and Save
// picks a folder on this computer (or downloads).
//
//   Open:  click a .zip or .pdf to open it. Signed in, "Upload a file here"
//          puts one from your computer in the folder you're in.
//   Save:  the folder you're in, a file name, and what to save:
//            <name>.zip              the presentation (reopens at this slide)
//            <name> (notes).pdf      the notes PDF
//            <name> recording (…)    any recordings you tick
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
import { listRecordings, getRecording, updateRecording, isRecording, formatSize, formatDuration } from '../app/recorder.js';

let appState = null;
const S = {
    repos: null,         // GitHub: the repositories the app can see (cached for the page)
    repo: null,          // GitHub: the repository in use
    src: null,           // the current source (see sources.js)
};
const NOTES_KEY = 'beamer.library.notes';
const REPO_KEY = 'beamer.library.repo';        // full name of the last repository
const LOC_KEY = 'beamer.library.where';        // { [source id]: last folder path }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const svg = (d, w = 1.8) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
    gh: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
    plus: svg('<path d="M12 5v14M5 12h14"/>', 2),
    up: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    folder: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
    deck: svg('<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/>'),
    pdf: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
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
function pickFile(accept, cb) {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept, hidden: true });
    input.addEventListener('change', () => { const f = input.files?.[0]; input.remove(); if (f) cb(f); });
    document.body.appendChild(input);
    input.click();
}
function confirmBox(title, message, yes) {
    return new Promise(res => window.BeamerModal?.show({
        kind: 'warning', title, message,
        buttons: [{ label: 'Cancel', kind: 'cancel', onClick: () => res(false) }, { label: yes, kind: 'ok', onClick: () => res(true) }],
        canClose: () => { res(false); return true; },
    }));
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
const notesPath = t => join(t.dir, `${t.name} (notes).pdf`);
function recordingPath(t, startedAt, ext) {
    const d = new Date(startedAt), z = n => String(n).padStart(2, '0');
    return join(t.dir, `${t.name} recording (${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}-${z(d.getMinutes())}).${ext}`);
}

/* ─── setup ───────────────────────────────────────────────────── */

export function initLibrary(state) {
    appState = state;
    setUploadButtonHandler(() => { openPresentation(); });
    // Signed in, decks come from GitHub: a dropped file doesn't open by itself.
    setDropHandler((file) => {
        if (!githubActive()) { appState.pendingGhTarget = null; openPresentationFile(file); return; }
        openPresentation();
        toast('Signed in, presentations open from GitHub. Use “Upload a file here” to put this one in the repository.');
    });
    bus.on('github:changed', () => { S.src = null; if (!githubActive()) S.repo = null; });
    bus.on('library:open', () => openPresentation());
}

/** The repository or folder in use, for display (or ''). */
export function sourceLabel() {
    if (githubActive()) return S.repo ? S.repo.full_name : (store.get(REPO_KEY) || '');
    return S.src ? `Folder: ${S.src.name}` : '';
}

// The source to use right now, or null while one still has to be chosen.
async function source() {
    if (githubActive()) {
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
    if (!S.src || S.src.kind !== 'folder') S.src = folderSource(await F.remembered());
    return S.src;
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
    };
    drawFoot(w);
    refreshWindow(w);
}

async function refreshWindow(w) {
    w.nav.innerHTML = ''; w.body.innerHTML = '';
    try {
        if (githubActive()) await drawRepoRow(w);
        else await drawFolderRow(w);
        const src = await source();
        if (!src) return;
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
        return;
    }
    const cur = S.repo?.full_name || '';
    w.srcBox.innerHTML = `
        <label class="gh-field"><span>Repository</span>
            <select data-repo>${cur ? '' : '<option value="" selected>Choose a repository…</option>'}${repos.map(r => `<option value="${esc(r.full_name)}"${r.full_name === cur ? ' selected' : ''}>${esc(r.full_name)}${r.private ? ' (private)' : ''}</option>`).join('')}</select></label>
        <p class="gh-muted gh-small">Not listed? <a href="${esc(install)}" target="_blank" rel="noopener">Give Beamer+ access</a>, then <button type="button" class="gh-link" data-again>check again</button>.</p>`;
    w.srcBox.querySelector('[data-repo]').onchange = (e) => {
        S.repo = repos.find(r => r.full_name === e.target.value) || null;
        S.src = null;
        store.set(REPO_KEY, S.repo?.full_name || null);
        w.cwd = null;
        refreshWindow(w);
    };
    w.srcBox.querySelector('[data-again]').onclick = () => { S.repos = null; refreshWindow(w); };
}

/* Signed out: the folder. */
async function drawFolderRow(w) {
    if (!F.supported()) {
        w.srcBox.innerHTML = `<p class="gh-note">This browser can’t save into folders (Chrome and Edge can). You can still download the presentation below.</p>`;
        return;
    }
    const h = await F.remembered();
    const perm = await F.permission();
    w.srcBox.innerHTML = `
        <div class="gh-field"><span>Folder</span>
            <div class="gh-folder">${ICON.folder}<span class="gh-folder-name">${h ? esc(h.name) : '<span class="gh-muted">No folder chosen</span>'}</span>
                ${h && perm !== 'granted' ? `<button type="button" class="gh-btn gh-btn--primary gh-btn--sm" data-allow>Allow access</button>` : ''}
                <button type="button" class="gh-btn gh-btn--sm${h ? '' : ' gh-btn--primary'}" data-choose>${h ? 'Change…' : 'Choose a folder…'}</button></div></div>`;
    w.srcBox.querySelector('[data-allow]')?.addEventListener('click', async () => { if (await F.reconnect()) { S.src = null; refreshWindow(w); } });
    w.srcBox.querySelector('[data-choose]').onclick = async () => {
        try { if (await F.choose()) { S.src = null; w.cwd = null; refreshWindow(w); } }
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
    w.body.innerHTML = `${listHTML(path, dirs, decks)}
        ${src.kind === 'github' ? `<p class="gh-row"><button type="button" class="gh-btn" data-upload>${ICON.upload}Upload a file here</button></p>` : ''}`;
    w.body.querySelectorAll('[data-dir]').forEach(b => { b.onclick = () => browse(w, src, b.dataset.dir); });
    w.body.querySelectorAll('[data-file]').forEach(b => { b.onclick = () => openDeck(src, decks[Number(b.dataset.file)]); });
    w.body.querySelector('[data-upload]')?.addEventListener('click', () => uploadHere(src, path, decks));
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

/* Signed in: put a file from this computer in this folder, then open it. */
function uploadHere(src, path, decks) {
    pickFile('.pdf,.zip,application/pdf,application/zip', async (file) => {
        if (!isDeck(file.name)) return showError('Can’t add that file', new Error(`“${file.name}” isn’t a PDF or a Beamer+ ZIP.`));
        if (src.limit && file.size > src.limit) return showError('Too large for GitHub', new Error(`${file.name} is ${formatSize(file.size)}; GitHub doesn’t accept files over 100 MB.`));
        const name = GH.cleanName(file.name) || 'presentation.pdf';
        if (decks.some(d => d.name === name) && !(await confirmBox('Replace it?', `This folder already has “${name}”. Replace it with this file?`, 'Replace'))) return;
        loading(`Uploading to ${src.where}…`, name);
        try {
            await src.write([{ path: join(path, name), blob: file }], `Beamer+: add ${join(path, name)}`, setLoading);
            appState.pendingGhTarget = { src: src.id, dir: path, name: baseOf(name) };
            window.BeamerModal?.close();
            openPresentationFile(new File([file], name, { type: file.type }));
            toast(`Uploaded to ${join(path, name)}.`);
        } catch (e) {
            appState.pendingGhTarget = null;
            window.BeamerModal?.close();
            showError('Couldn’t upload it', e);
        }
    });
}

/* Save: this folder, a name, and what to save. */
async function drawSaveForm(w, src, path, dirs, decks) {
    const t0 = appState.ghTarget;
    if (w.name === null) w.name = t0 && t0.src === src.id ? t0.name : (GH.cleanName(appState.deckName) || 'presentation');
    let recs = [];
    try { recs = await listRecordings(); } catch { /* none */ }
    const zips = decks.filter(d => /\.zip$/i.test(d.name));
    const recRow = (r, on) => {
        const done = r.uploaded && r.uploaded.repo === src.id;
        const big = !!src.limit && (r.size || 0) > src.limit;
        const when = new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const note = done ? 'already saved there' : big ? 'over GitHub’s 100 MB limit' : '';
        return `<label class="gh-check${done || big ? ' is-off' : ''}"><input type="checkbox" data-rec="${esc(r.id)}"${on && !done && !big ? ' checked' : ''}${done || big ? ' disabled' : ''}>
            <span><b>${esc(r.label)}</b> <span class="gh-muted">${esc([r.deckName, when, formatDuration(r.durationMs || 0), formatSize(r.size || 0)].filter(Boolean).join(' · '))}</span>${note ? ` <em>${note}</em>` : ''}</span></label>`;
    };
    w.body.innerHTML = `${listHTML(path, dirs, zips, { filesQuiet: true })}
        <div class="gh-row gh-newdir-row"><button type="button" class="gh-link" data-newdir>${ICON.plus}New folder</button>
            <span class="gh-newdir" hidden><input data-dirname placeholder="Folder name" spellcheck="false"><button type="button" class="gh-btn gh-btn--sm" data-mkdir>Create</button></span></div>
        <label class="gh-field"><span>File name</span>
            <span class="gh-name"><input data-name value="${esc(w.name)}" spellcheck="false" autocomplete="off"><span class="gh-ext">.zip</span></span></label>
        <p class="gh-muted gh-small" data-hint></p>
        <div class="gh-checks">
            <label class="gh-check"><input type="checkbox" data-deck checked><span><b>Presentation</b> <span class="gh-muted" data-p-deck></span></span></label>
            <label class="gh-check"><input type="checkbox" data-notes${wantNotes() ? ' checked' : ''}><span><b>Notes PDF</b> <span class="gh-muted" data-p-notes></span></span></label>
            ${recs.length || isRecording() ? `<div class="gh-recs"><div class="gh-recs-head">Recordings <span class="gh-muted">saved beside it</span></div>
                <div data-recs></div>
                ${isRecording() ? '<p class="gh-muted gh-small">A recording is in progress: stop it to include it.</p>' : ''}</div>` : ''}
        </div>
        <p class="gh-err" data-save-err></p>
        <p class="gh-row gh-row--end"><button type="button" class="gh-btn" data-cancel>Cancel</button>
            <button type="button" class="gh-btn gh-btn--primary" data-save>Save</button></p>`;
    const nameIn = w.body.querySelector('[data-name]');
    const recBox = w.body.querySelector('[data-recs]');
    const sync = () => {
        w.name = nameIn.value;
        const n = GH.cleanName(nameIn.value);
        w.body.querySelector('[data-hint]').textContent = !n ? 'Name the file.'
            : zips.some(z => z.name === `${n}.zip`) ? `Replaces ${n}.zip in this folder.` : `Saves ${join(path, `${n}.zip`)}.`;
        w.body.querySelector('[data-p-deck]').textContent = n ? `${n}.zip · opens at this slide next time` : '';
        w.body.querySelector('[data-p-notes]').textContent = n ? `${n} (notes).pdf · annotations and widgets drawn in` : '';
        if (recBox) {
            const key = targetKey({ dir: path, name: n });
            const mine = recs.filter(r => r.lecture === key), others = recs.filter(r => r.lecture !== key);
            const ticked = new Set([...recBox.querySelectorAll('[data-rec]:checked')].map(x => x.dataset.rec));
            recBox.innerHTML = mine.map(r => recRow(r, true)).join('') + others.map(r => recRow(r, ticked.has(r.id))).join('');
        }
    };
    nameIn.addEventListener('input', sync);
    sync();
    w.body.querySelectorAll('[data-dir]').forEach(b => { b.onclick = () => browse(w, src, b.dataset.dir); });
    w.body.querySelectorAll('[data-file]').forEach(b => { b.onclick = () => { nameIn.value = baseOf(zips[Number(b.dataset.file)].name); sync(); }; });
    const newdir = w.body.querySelector('.gh-newdir');
    w.body.querySelector('[data-newdir]').onclick = () => { newdir.hidden = false; newdir.querySelector('input').focus(); };
    const mkdir = () => {
        const n = GH.cleanName(newdir.querySelector('input').value);
        if (n) browse(w, src, join(path, n));         // made when something is saved in it
    };
    w.body.querySelector('[data-mkdir]').onclick = mkdir;
    newdir.querySelector('input').addEventListener('keydown', e => { if (e.key === 'Enter') mkdir(); });
    w.body.querySelector('[data-cancel]').onclick = () => window.BeamerModal?.close();
    w.body.querySelector('[data-save]').onclick = () => {
        const n = GH.cleanName(nameIn.value);
        const err = w.body.querySelector('[data-save-err]');
        if (!n) { err.textContent = 'Name the file first.'; nameIn.focus(); return; }
        const deck = w.body.querySelector('[data-deck]').checked;
        const notes = w.body.querySelector('[data-notes]').checked;
        const ids = [...w.body.querySelectorAll('[data-rec]:checked')].map(x => x.dataset.rec);
        if (!deck && !notes && !ids.length) { err.textContent = 'Tick something to save.'; return; }
        try { localStorage.setItem(NOTES_KEY, notes ? '1' : '0'); } catch { /* ignore */ }
        appState.ghTarget = { src: src.id, dir: path, name: n };
        updateTitle();
        window.BeamerModal?.close();
        setTimeout(() => saveNow(src, { deck, notes, recordings: ids }), 0);
    };
    setTimeout(() => nameIn.focus(), 0);
}

/** Ctrl/⌘+S: save straight away where the presentation came from (the deck,
 *  and the notes unless you turned them off). The window opens instead the
 *  first time, or when there are new recordings for it to ask about. */
export async function quickSave() {
    if (!appState.zipFile) return;
    let src = null;
    try { src = await source(); } catch { /* the window explains */ }
    const t = appState.ghTarget;
    if (!src || !t || t.src !== src.id) return savePresentation();
    let fresh = [];
    try {
        fresh = (await listRecordings()).filter(r => r.lecture === targetKey(t) && !(r.uploaded && r.uploaded.repo === src.id) && !(src.limit && (r.size || 0) > src.limit));
    } catch { /* none */ }
    if (fresh.length) return savePresentation();
    return saveNow(src, { deck: true, notes: wantNotes(), recordings: [] });
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
