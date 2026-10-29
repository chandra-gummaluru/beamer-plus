// "Open a presentation" and "Save presentation", with the computer's own
// file windows (library/folder.js).
//
//   Open:  the system's Open window, showing presentations only (.zip, .pdf).
//          New Session on the start page shows it (a browser only shows its
//          file window after a click) and the session opens the file chosen.
//          A session with nothing open has Open a File… on its empty stage;
//          a file dropped on the window opens too.
//   Save:  first a window for the title and what to save:
//            <title>.zip                         the presentation (reopens at this slide)
//            <title>.pdf                         the notes PDF
//            <title>-<yyyy-mm-dd>-<hh-mm>.mp4    recordings (or .webm)
//          then Save… opens the system's folder window to choose where. It
//          starts in the folder the deck was last saved to or opened from,
//          else where you last saved.
//
// Browsers without the File System Access API (not Chrome or Edge): Open is
// the plain file picker and Save downloads.

import { bus } from '../core/events.js';
import * as Folder from './folder.js';
import { toast } from '../app/toast.js';
import { setDropHandler, chooseLocalFile, openPresentationFile } from '../app/uploader.js';
import { buildPresentationZip } from '../editor/save.js';
import { buildNotesPdf } from '../editor/notes-export.js';
import { listRecordings, getRecording, updateRecording } from '../app/recorder.js';

let appState = null;

// Where files go: a folder chosen in the system's folder window, or the
// browser's downloads ("Or download instead").
const inFolder = dir => ({
    kind: 'folder', id: 'folder', name: dir.name, where: dir.name,
    write: (files, onStep) => Folder.write(dir, files, onStep),
});
const COMPUTER = {
    kind: 'computer', id: 'computer', name: 'this computer', where: 'your downloads',
    async write(files) {
        for (const f of files) {
            const url = URL.createObjectURL(f.blob);
            const a = Object.assign(document.createElement('a'), { href: url, download: f.path });
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            await new Promise(r => setTimeout(r, 400));          // so the browser takes each one
        }
    },
};
const NOTES_KEY = 'beamer.library.notes';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const svg = (d, w = 1.8) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
    folder: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
    deck: svg('<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/>'),
    pdf: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    rec: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>'),
    tick: '<svg class="lib-chip-tick" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};
const extOf = name => (/\.([a-z0-9]+)$/i.exec(name || '') || [, ''])[1].toLowerCase();
const baseOf = name => String(name || '').replace(/\.(zip|pdf)$/i, '');
/** A name that's safe as a file name on any system. */
const cleanName = s => String(s || '').replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
const wantNotes = () => { try { return localStorage.getItem(NOTES_KEY) !== '0'; } catch { return true; } };
const showError = (title, err) => window.BeamerModal?.show({ kind: 'error', title, message: err?.message || String(err) });
const loading = (title, message = '') => window.BeamerModal?.show({ kind: 'loading', title, message });
function setLoading(message) {
    const el = window.BeamerModal?.open?.querySelector('.custom-modal-message');
    if (el) el.textContent = message;
}

/** What recordings of this presentation are matched by (its title). */
export const targetKey = t => (t ? t.name : null);
const zipName = t => `${t.name}.zip`;
const notesName = t => `${t.name}.pdf`;
function recordingName(t, meta, ext) {
    // A take split into parts: all parts carry the take's start time, plus "-part<n>".
    const d = new Date(meta.groupStartedAt || meta.startedAt), z = n => String(n).padStart(2, '0');
    const part = meta.part && (meta.part > 1 || / part 1 /.test(meta.fileName || '')) ? `-part${meta.part}` : '';
    return `${t.name}-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}-${z(d.getMinutes())}${part}.${ext}`;
}

/* ─── setup ───────────────────────────────────────────────────── */

export function initLibrary(state) {
    appState = state;
    // A file dropped on the window opens as it is.
    setDropHandler((file) => { appState.pendingTarget = null; openPresentationFile(file); });
    bus.on('library:require', requirePresentation);
    bus.on('deck:loaded', updateTitle);
    document.getElementById('stage-open-btn')?.addEventListener('click', () => openPresentation());
    Folder.warm();
}

/** The tab's title: the presentation's name. */
function updateTitle() {
    const t = appState?.target;
    const name = t?.name || (appState?.zipFile ? appState.deckName : '');
    document.title = name ? `${name} · Beamer+` : 'Beamer+';
}

/* ─── Open ────────────────────────────────────────────────────── */

/** The system's Open window (needs a click). */
export async function openPresentation() {
    if (!Folder.supported()) { appState.pendingTarget = null; chooseLocalFile(); return; }
    let got;
    try { got = await Folder.pickDeck(); }
    catch (e) { showError('Couldn’t open it', e); return; }
    if (!got) return;                                     // cancelled
    appState.pendingTarget = { src: 'folder', dir: '', name: baseOf(got.file.name), file: got.handle };
    openPresentationFile(got.file);
}

/* A session from New Session: open the file the start page chose. Without
   one (a reload, a link), the empty stage's Open a File… does it. */
async function requirePresentation() {
    if (appState.zipFile) return;
    const got = await Folder.takeOpen().catch(() => null);
    if (!got?.file || appState.zipFile) return;
    appState.pendingTarget = { src: 'folder', dir: '', name: baseOf(got.file.name), file: got.handle || null };
    openPresentationFile(got.file);
}

/* ─── Save ────────────────────────────────────────────────────── */

// The takes a save offers: those recorded with this presentation (or with no
// presentation yet) that aren't saved already.
async function takesFor(key) {
    let recs = [];
    try { recs = await listRecordings(); } catch { /* none */ }
    return recs.filter(r => (!r.lecture || r.lecture === key || r.lecture.endsWith(`/${key}`)) && !r.uploaded)
        .sort((a, b) => a.startedAt - b.startedAt);
}

/** The Save window: the title and what to save; Save… then asks where. */
export async function savePresentation(prev = null) {
    if (!appState.zipFile) return;
    const t0 = appState.target;
    const takes = await takesFor(t0 ? targetKey(t0) : null);
    const folders = Folder.supported();
    const title = prev?.title ?? (t0?.name || cleanName(appState.deckName) || 'presentation');
    const tick = (k, dflt) => (prev ? prev[k] : dflt);
    const root = document.createElement('div');
    root.className = 'lib';
    root.dataset.mode = 'save';
    root.innerHTML = `
        <label class="lib-field"><span>Title</span>
            <input class="field" data-name value="${esc(title)}" spellcheck="false" autocomplete="off"></label>
        <div class="lib-field"><span>Save</span>
            <div class="lib-chips" role="group" aria-label="What to save">
                <label class="lib-chip" title="The presentation: reopens at the slide you're on"><input type="checkbox" data-deck${tick('deck', true) ? ' checked' : ''}><span>${ICON.deck}Presentation${ICON.tick}</span></label>
                <label class="lib-chip" title="One PDF with your annotations and widgets drawn in"><input type="checkbox" data-notes${tick('notes', wantNotes()) ? ' checked' : ''}><span>${ICON.pdf}Notes${ICON.tick}</span></label>
                <label class="lib-chip" title="${takes.length ? `${takes.length} recording${takes.length > 1 ? 's' : ''} not saved yet` : 'No recordings to save'}"><input type="checkbox" data-recs${takes.length && tick('recs', true) ? ' checked' : ''}${takes.length ? '' : ' disabled'}><span>${ICON.rec}Recordings${takes.length ? ` <small>${takes.length}</small>` : ''}${ICON.tick}</span></label>
            </div></div>
        <p class="lib-err" data-save-err></p>
        <div class="lib-foot">
            <button type="button" class="btn" data-cancel>Cancel</button>
            <button type="button" class="btn btn--primary" data-save>${folders ? 'Save…' : 'Download'}</button>
        </div>`;
    window.BeamerModal?.show({ kind: 'info', title: 'Save Presentation', body: root, buttons: [] });
    window.BeamerModal?.open?.querySelector('.custom-modal-content')?.classList.add('lib-modal');

    const $ = s => root.querySelector(s);
    const nameIn = $('[data-name]'), err = $('[data-save-err]');
    // What's filled in, or null (with the reason shown) if it can't be saved yet.
    const choices = () => {
        const n = cleanName(nameIn.value);
        if (!n) { err.textContent = 'Give it a title first.'; nameIn.focus(); return null; }
        const c = { title: n, deck: $('[data-deck]').checked, notes: $('[data-notes]').checked, recs: $('[data-recs]').checked };
        if (!c.deck && !c.notes && !(c.recs && takes.length)) { err.textContent = 'Tick something to save.'; return null; }
        err.textContent = '';
        try { localStorage.setItem(NOTES_KEY, c.notes ? '1' : '0'); } catch { /* ignore */ }
        return c;
    };
    const go = (c, src) => {
        appState.target = { ...(appState.target || {}), src: src.id, dir: '', name: c.title, ...(src.kind === 'folder' ? { folder: src.dir } : {}) };
        updateTitle();
        window.BeamerModal?.close();
        setTimeout(() => saveNow(src, { deck: c.deck, notes: c.notes, recordings: c.recs ? takes.map(r => r.id) : [] }), 0);
    };

    $('[data-cancel]').onclick = () => window.BeamerModal?.close();
    $('[data-save]').onclick = async () => {
        const c = choices();
        if (!c) return;
        if (!folders) return go(c, COMPUTER);
        // Where: the system's folder window, starting by this deck's folder.
        const t = appState.target;
        let dir;
        try { dir = await Folder.pickSaveFolder(t?.folder || t?.file || null); }
        catch (e) { err.textContent = e?.message || String(e); return; }
        if (!dir) return;                                 // cancelled: the window stays
        const src = { ...inFolder(dir), dir };
        // Ask before replacing a presentation or notes already there.
        const names = [c.deck && `${c.title}.zip`, c.notes && `${c.title}.pdf`].filter(Boolean);
        const there = await Folder.existing(dir, names);
        if (!there.length) return go(c, src);
        window.BeamerModal?.show({
            kind: 'warning',
            title: there.length > 1 ? 'Replace These Files?' : 'Replace This File?',
            message: `${there.join(' and ')} ${there.length > 1 ? 'are' : 'is'} already in ${dir.name}.`,
            buttons: [
                { label: 'Cancel', kind: 'cancel', onClick: () => setTimeout(() => savePresentation(c), 0) },
                { label: 'Replace', kind: 'ok', onClick: () => setTimeout(() => go(c, src), 0) },
            ],
        });
    };
    nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') $('[data-save]').click(); });
    setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
}

let saving = false;
async function saveNow(src, { deck = true, notes, recordings }) {
    const t = appState.target;
    if (!t || saving) return;
    saving = true;
    document.body.classList.add('lib-saving');
    loading(src.kind === 'computer' ? 'Downloading…' : `Saving to ${src.where}…`, 'Building the presentation…');
    const files = [], saved = [];
    try {
        bus.emit('annotations:flush');
        if (deck) {
            const zip = await buildPresentationZip({
                extra: { 'config/resume.json': JSON.stringify({ slide: appState.currentSlide, savedAt: new Date().toISOString() }) },
            });
            files.push({ path: zipName(t), blob: zip });
        }
        if (notes) {
            setLoading('Building the notes PDF…');
            files.push({ path: notesName(t), blob: await buildNotesPdf() });
        }
        for (const id of recordings) {
            const r = await getRecording(id);
            if (!r) continue;
            const path = recordingName(t, r.meta, extOf(r.meta.fileName) || 'webm');
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
    loading(src.kind === 'computer' ? 'Downloading…' : `Saving to ${src.where}…`, '');
    try {
        await src.write(files, setLoading);
        if (src.kind !== 'computer') {
            for (const u of saved) await updateRecording(u.id, { uploaded: { repo: src.id, path: `${src.name}/${u.path}`, at: Date.now() } });
        }
        window.BeamerModal?.close();
        const extra = [notes && (deck ? 'notes' : 'the notes'), saved.length && `${saved.length} recording${saved.length > 1 ? 's' : ''}`].filter(Boolean);
        toast(src.kind === 'computer'
            ? `Downloaded${extra.length ? `, with ${extra.join(' and ')}` : ''}.`
            : `Saved ${deck ? `${src.name}/${zipName(t)}` : `in ${src.name}`}${extra.length ? `, with ${extra.join(' and ')}` : ''}.`);
        bus.emit('library:saved', { target: t });
    } catch (e) {
        console.error('[library] save failed', e);
        const kept = saved.length ? ' Your recordings stay in Beamer+, ready for the next save.' : '';
        const buttons = [
            { label: 'Close', kind: 'cancel' },
            { label: 'Try Again', kind: src.kind === 'computer' ? 'ok' : 'cancel', onClick: () => setTimeout(() => writeOut(src, t, files, saved, { deck, notes }), 0) },
        ];
        if (src.kind !== 'computer') {
            buttons.push({ label: 'Download Instead', kind: 'ok', onClick: () => setTimeout(() => writeOut(COMPUTER, t, files, saved, { deck, notes }), 0) });
        }
        window.BeamerModal?.show({
            kind: 'error',
            title: `Couldn’t Save to ${src.where}`,
            message: `${e?.message || String(e)}${kept}`,
            buttons,
        });
    } finally {
        saving = false;
        document.body.classList.remove('lib-saving');
    }
}
