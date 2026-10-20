// GitHub in the presenter: the lecture library behind "open a presentation"
// (the empty slide, the account menu), and Save to GitHub (the account menu,
// and Ctrl/⌘+S; see app/account-menu.js).
//
//   Open → "Open a lecture": course offering → lecture → its decks.
//     A deck saved before opens where it left off (Resume); "Start over"
//     opens the original instead. A lecture can take a new deck from this
//     computer, and new lectures and course offerings can be started here.
//   Save → "Save to GitHub": the deck as it is now (with the slide
//     you're on), the notes PDF and, if you tick them, recordings. See
//     library.js for where each file goes.
//
// Signed out (a guest), none of this runs: the buttons work as before.

import { bus } from '../core/events.js';
import { signedIn, user, signOut, startSignIn, appConfig, schedule, GhError } from './auth.js';
import * as L from './library.js';
import { setUploadButtonHandler, setDropHandler, openPresentationFile } from '../app/uploader.js';
import { buildPresentationZip } from '../editor/save.js';
import { buildNotesPdf } from '../editor/notes-export.js';
import { listRecordings, getRecording, updateRecording, isRecording, formatSize, formatDuration } from '../app/recorder.js';

let appState = null;
let active = false;     // signed in, and not a guest session
const G = {
    me: null,           // { login, avatar_url }
    pair: null,         // { priv, pub } repositories
    lib: null,          // Promise of the library Map (see library.readLibrary)
    lastOffering: null, // "c/t" shown last
};
const NOTES_KEY = 'beamer.github.notes';
const OFFERING_KEY = 'beamer.github.offering';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const svg = (d, w = 1.8) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
    gh: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
    plus: svg('<path d="M12 5v14M5 12h14"/>', 2),
    play: svg('<path d="M7 4.5v15l12-7.5z"/>'),
    reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    laptop: svg('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M2 20h20"/>'),
    deck: svg('<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/>'),
    lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>'),
    save: svg('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>'),
};

/* ─── setup ───────────────────────────────────────────────────── */

export function initGitHub(state) {
    appState = state;
    // A session started with "Continue as guest" stays a guest session, even
    // when this browser holds a GitHub sign-in.
    const params0 = new URLSearchParams(location.search);
    const guestKey = `beamer.github.guest:${location.pathname}`;
    try {
        if (params0.has('guest')) {
            sessionStorage.setItem(guestKey, '1');
            params0.delete('guest');
            const qs = params0.toString();
            history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
        }
        if (sessionStorage.getItem(guestKey)) return;
    } catch { /* storage blocked */ }
    if (!signedIn()) return;          // a guest: nothing changes
    schedule();
    active = true;
    document.body.classList.add('gh-signed-in');
    setUploadButtonHandler(() => { openLibrary(); });
    // Signed in, decks come from GitHub: a file dropped on the window doesn't
    // open by itself; the library opens so it can go into a lecture first.
    setDropHandler(() => {
        openLibrary();
        toast('Signed in, presentations open from GitHub. Put this file in a lecture with “Add a deck” or “New lecture”.');
    });
    bus.emit('github:changed');

    bus.on('deck:loaded', () => { updateTitle(); bus.emit('github:changed'); });
    user().then(u => { G.me = u; bus.emit('github:changed'); }).catch(e => { if (e.status === 401) githubSignOut(); });
    ensurePair().then(() => bus.emit('github:changed')).catch(() => {});

    // Just signed in from the welcome page: open the library once the splash is gone.
    const params = new URLSearchParams(location.search);
    if (params.has('gh')) {
        params.delete('gh');
        const qs = params.toString();
        history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
        setTimeout(() => { if (!appState.zipFile && !document.querySelector('.custom-modal-overlay')) openLibrary(); }, 2100);
    }
}

function updateTitle() {
    const t = appState.ghTarget;
    document.title = t ? `${t.lecture} · Beamer+` : 'Beamer+';
}

/** True when this session saves to GitHub (signed in, not a guest session). */
export const githubActive = () => active && signedIn();

/** Ctrl/⌘+S: a quick save. The first save asks which lecture the deck belongs
 *  in; new recordings for the lecture bring up the dialog so you can pick
 *  them; otherwise it saves straight away (the deck, and the notes unless you
 *  turned them off). */
export async function saveToGitHub() {
    if (!appState.zipFile) return;
    const t = appState.ghTarget;
    if (!t) return openSaveDialog();
    let fresh = [];
    try {
        const pubName = G.pair ? (L.twoRepos(G.pair) ? G.pair.pub : G.pair.priv).full_name : null;
        const key = `${t.c}/${t.t}/${t.lecture}`;
        fresh = (await listRecordings()).filter(r => r.lecture === key && !(r.uploaded && r.uploaded.repo === pubName) && (r.size || 0) <= L.MAX_BYTES);
    } catch { /* none */ }
    if (fresh.length) return openSaveDialog();
    return saveNow({ notes: wantNotes(), recordings: [] });
}

/** The Save button: the dialog asking what to save to GitHub (the deck,
 *  the notes PDF, recordings). The first time, it asks which lecture. */
export function openGitHubSave() { return openSaveDialog(); }

/* ─── small UI helpers ────────────────────────────────────────── */

let toastTimer = null;
function toast(text) {
    let el = document.getElementById('recorder-toast');      // shares the recorder's toast styling
    if (!el) {
        el = document.createElement('div');
        el.id = 'recorder-toast';
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 5000);
}
const showError = (title, err) => window.BeamerModal?.show({ kind: 'error', title, message: err?.message || String(err) });
const loading = (title, message = '') => window.BeamerModal?.show({ kind: 'loading', title, message });
function setLoading(message) {
    const el = window.BeamerModal?.open?.querySelector('.custom-modal-message');
    if (el) el.textContent = message;
}
const wantNotes = () => { try { return localStorage.getItem(NOTES_KEY) !== '0'; } catch { return true; } };
const fmtWhen = d => d ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const extOf = name => (/\.([a-z0-9]+)$/i.exec(name || '') || [, ''])[1].toLowerCase();

function confirmBox(title, message, yes) {
    return new Promise(res => window.BeamerModal?.show({
        kind: 'warning', title, message,
        buttons: [{ label: 'Cancel', kind: 'cancel', onClick: () => res(false) },
                  { label: yes, kind: 'ok', onClick: () => res(true) }],
        canClose: () => { res(false); return true; },
    }));
}

function pickFile(accept, cb) {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept, hidden: true });
    input.addEventListener('change', () => { const f = input.files?.[0]; input.remove(); if (f) cb(f); });
    document.body.appendChild(input);
    input.click();
}

/* ─── connection + library ────────────────────────────────────── */

async function ensurePair() {
    if (G.pair) return G.pair;
    G.pair = await L.loadChoice();
    return G.pair;
}
function library(force = false) {
    if (!G.lib || force) {
        const pair = G.pair;
        G.lib = Promise.all([L.tree(pair.priv), L.twoRepos(pair) ? L.tree(pair.pub) : Promise.resolve([])])
            .then(([a, b]) => L.readLibrary(a, b));
        G.lib.catch(() => { G.lib = null; });
    }
    return G.lib;
}

/* ─── the library modal ───────────────────────────────────────── */
// mode 'open': pick a deck to open. mode 'save': pick the lecture this deck
// goes in (then the save dialog follows).

/** "Change repository" (the account menu). */
export function openRepoChooser() { openLibrary({ mode: 'open', repo: true }); }

function openLibrary({ mode = 'open', repo = false } = {}) {
    const root = document.createElement('div');
    root.className = 'gh-lib';
    root.innerHTML = `<div class="gh-lib-body"><p class="gh-muted">Connecting to GitHub…</p></div>
        <div class="gh-lib-foot"></div>`;
    window.BeamerModal?.show({
        kind: 'info',
        title: mode === 'save' ? 'Save to GitHub' : 'Open a lecture',
        body: root,
        buttons: [],
    });
    window.BeamerModal?.open?.querySelector('.custom-modal-content')?.classList.add('gh-modal');
    const body = root.querySelector('.gh-lib-body');
    const foot = root.querySelector('.gh-lib-foot');
    const ctxt = { root, body, foot, mode, adding: null };

    drawFoot(ctxt);
    (async () => {
        try {
            if (!G.me) G.me = await user();
            drawFoot(ctxt);
            if (repo || !(await ensurePair())) return repoPicker(ctxt);
            drawFoot(ctxt);
            await drawLibrary(ctxt);
        } catch (e) {
            if (e.status === 401) return signInAgain(ctxt, e);
            body.innerHTML = `<p class="gh-err">${esc(e.message)}</p>
                <p><button type="button" class="gh-btn" data-retry>Try again</button></p>`;
            body.querySelector('[data-retry]').onclick = () => openLibrary({ mode });
        }
    })();
}

function signInAgain(ctxt, e) {
    ctxt.body.innerHTML = `<p class="gh-err">${esc(e.message)}</p>
        <p><button type="button" class="gh-btn gh-btn--primary" data-in>${ICON.gh}Sign in with GitHub</button></p>`;
    ctxt.body.querySelector('[data-in]').onclick = () => startSignIn({ back: location.pathname }).catch(err => showError('Sign-in', err));
}

function drawFoot(ctxt) {
    const who = G.me ? esc(G.me.login) : '…';
    const repo = G.pair ? (L.twoRepos(G.pair) ? `${G.pair.pub.full_name} + -private` : G.pair.priv.full_name) : '';
    ctxt.foot.innerHTML = `
        ${ctxt.mode === 'open' ? `<div class="gh-row"><button type="button" class="gh-link" data-demo title="Opens a demo deck with a guided tour">${ICON.play}Demo presentation</button></div>` : ''}
        <div class="gh-acct">${ICON.gh}<span>${who}${repo ? ` · <span title="Your course repository">${esc(repo)}</span>` : ''}</span>
            ${G.pair ? '<button type="button" class="gh-link" data-repo>Change</button>' : ''}
            <button type="button" class="gh-link" data-out>Sign out</button></div>`;
    ctxt.foot.querySelector('[data-demo]')?.addEventListener('click', () => { window.BeamerModal?.close(); bus.emit('demo:open'); });
    ctxt.foot.querySelector('[data-repo]')?.addEventListener('click', () => repoPicker(ctxt));
    ctxt.foot.querySelector('[data-out]')?.addEventListener('click', () => { window.BeamerModal?.close(); githubSignOut(); });
}

/** Sign out, staying in this session as a guest (the open deck stays open). */
export function githubSignOut() {
    signOut();
    document.body.classList.remove('gh-signed-in');
    setUploadButtonHandler(null);
    setDropHandler(null);
    if (appState) appState.ghTarget = null;
    active = false;
    G.me = null;
    updateTitle();
    bus.emit('github:changed');
    toast('Signed out of GitHub. Beamer+ works as a guest until you sign in again.');
}

/** Who's signed in ({ login, avatar_url }), or null. */
export async function githubUser() {
    if (!githubActive()) return null;
    if (!G.me) { try { G.me = await user(); } catch { return null; } }
    return G.me;
}

/** The course repository, for display ("courses-utor + -private"), or ''. */
export function githubRepoLabel() {
    if (!G.pair) return '';
    return L.twoRepos(G.pair) ? `${G.pair.pub.full_name} (+ -private)` : G.pair.priv.full_name;
}

/* Choosing the course repository (once; remembered in this browser). */
async function repoPicker(ctxt) {
    const { body } = ctxt;
    body.innerHTML = `<p class="gh-muted">Finding your repositories…</p>`;
    let repos, cfg;
    try { [repos, cfg] = await Promise.all([L.listRepos(), appConfig()]); }
    catch (e) { body.innerHTML = `<p class="gh-err">${esc(e.message)}</p>`; return; }
    const install = cfg.app_slug ? `https://github.com/apps/${encodeURIComponent(cfg.app_slug)}/installations/new` : 'https://github.com/settings/installations';
    // Offer each pair once, by its public name; and every repository without a twin.
    const names = repos.map(r => r.full_name);
    const shown = names.filter(n => !(/-private$/i.test(n) && names.some(m => m.toLowerCase() === n.replace(/-private$/i, '').toLowerCase())));
    let pick = G.pair?.pub.full_name || shown.find(n => names.some(m => m.toLowerCase() === `${n}-private`.toLowerCase())) || shown[0] || '';
    const draw = () => {
        const pair = pick ? L.pairFor(pick, repos) : null;
        body.innerHTML = !repos.length
            ? `<p><b>Beamer+ can’t see any of your repositories yet.</b> On GitHub, give it access to your course repository (and its <code>-private</code> twin), then check again.</p>
               <p class="gh-row"><a class="gh-btn gh-btn--primary" href="${esc(install)}" target="_blank" rel="noopener">${ICON.gh}Give Beamer+ access</a><button type="button" class="gh-btn" data-again>Check again</button></p>`
            : `<p class="gh-muted">Your course repository: the one Lectern uses too, e.g. <code>courses-utor</code> with <code>courses-utor-private</code>.</p>
               <label class="gh-field"><span>Repository</span><select data-repo>${shown.map(n => `<option${n === pick ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
               ${pair ? (L.twoRepos(pair)
                    ? `<ul class="gh-where"><li>${ICON.lock}<span>Presentations: <code>${esc(pair.priv.full_name)}</code></span></li><li>${ICON.globe}<span>Notes and recordings: <code>${esc(pair.pub.full_name)}</code>, where your course page can link them</span></li></ul>`
                    : `<p class="gh-note">Everything goes in <code>${esc(pair.priv.full_name)}</code>${pair.priv.private ? '' : ', which is <b>public</b>: presentations too'}. To keep presentations private, give Beamer+ access to <code>${esc(pick)}-private</code> as well.</p>`) : ''}
               <p class="gh-muted gh-small">Not listed? <a href="${esc(install)}" target="_blank" rel="noopener">Give Beamer+ access to it on GitHub</a>, then <button type="button" class="gh-link" data-again>check again</button>.</p>
               <p class="gh-row gh-row--end"><button type="button" class="gh-btn gh-btn--primary" data-use${pair ? '' : ' disabled'}>Use this repository</button></p>`;
        body.querySelector('[data-repo]')?.addEventListener('change', e => { pick = e.target.value; draw(); });
        body.querySelectorAll('[data-again]').forEach(b => { b.onclick = () => repoPicker(ctxt); });
        body.querySelector('[data-use]')?.addEventListener('click', async () => {
            G.pair = pair; G.lib = null;
            L.saveChoice(pair);
            drawFoot(ctxt);
            await drawLibrary(ctxt).catch(e => { body.innerHTML = `<p class="gh-err">${esc(e.message)}</p>`; });
        });
    };
    draw();
}

async function drawLibrary(ctxt, force = false) {
    const { body, mode } = ctxt;
    body.innerHTML = `<p class="gh-muted">Reading ${esc(G.pair.priv.full_name)}…</p>`;
    const lib = await library(force);
    const offs = L.sortedOfferings(lib);
    let key = G.lastOffering || appState.ghTarget && `${appState.ghTarget.c}/${appState.ghTarget.t}`;
    try { key = key || localStorage.getItem(OFFERING_KEY); } catch { /* ignore */ }
    if (!lib.has(key)) key = offs[0] ? `${offs[0].c}/${offs[0].t}` : '';
    G.lastOffering = key;

    const o = lib.get(key);
    body.innerHTML = `
        <label class="gh-field"><span>Course offering</span>
            <select data-off>${offs.map(x => `<option value="${esc(`${x.c}/${x.t}`)}"${`${x.c}/${x.t}` === key ? ' selected' : ''}>${esc(`${x.c} / ${x.t}`)}${L.isTerm(x.t) ? ` · ${esc(L.termName(x.t))}` : ''}</option>`).join('')}
            <option value="__new">New course offering…</option></select></label>
        <div class="gh-newoff" hidden>
            <div class="gh-two"><label class="gh-field"><span>Course</span><input data-c placeholder="e.g. csc258" spellcheck="false"></label>
            <label class="gh-field"><span>Term</span><input data-t placeholder="e.g. f26" spellcheck="false"></label></div>
            <p class="gh-muted gh-small">A folder <code>course/term</code>, like Lectern’s. It’s made when the first lecture is saved in it.</p>
            <p class="gh-row gh-row--end"><button type="button" class="gh-btn" data-cancel-off>Cancel</button><button type="button" class="gh-btn gh-btn--primary" data-make-off>Continue</button></p>
            <p class="gh-err" data-off-err></p>
        </div>
        <div class="gh-lectures"></div>`;
    const sel = body.querySelector('[data-off]');
    const newOff = body.querySelector('.gh-newoff');
    sel.onchange = () => {
        if (sel.value === '__new') { newOff.hidden = false; body.querySelector('.gh-lectures').hidden = true; body.querySelector('[data-c]').focus(); return; }
        G.lastOffering = sel.value;
        try { localStorage.setItem(OFFERING_KEY, sel.value); } catch { /* ignore */ }
        drawLibrary(ctxt);
    };
    body.querySelector('[data-cancel-off]').onclick = () => drawLibrary(ctxt);
    body.querySelector('[data-make-off]').onclick = () => {
        const c = L.cleanName(body.querySelector('[data-c]').value).replace(/\s+/g, '').toLowerCase();
        const t = L.cleanName(body.querySelector('[data-t]').value).replace(/\s+/g, '').toLowerCase();
        if (!c || !t) { body.querySelector('[data-off-err]').textContent = 'Give both the course and the term.'; return; }
        if (!lib.has(`${c}/${t}`)) lib.set(`${c}/${t}`, { c, t, lectures: new Map(), known: true });
        G.lastOffering = `${c}/${t}`;
        ctxt.adding = 'new';
        drawLibrary(ctxt);
    };
    if (!o) {
        body.querySelector('.gh-lectures').innerHTML = `<p class="gh-muted">No course offerings in ${esc(G.pair.priv.full_name)} yet. Start one with <b>New course offering…</b> above.</p>`;
        if (!offs.length) { sel.value = '__new'; sel.onchange(); }
        return;
    }
    drawLectures(ctxt, o);
}

function drawLectures(ctxt, o) {
    const { body, mode } = ctxt;
    const box = body.querySelector('.gh-lectures');
    const lectures = L.sortedLectures(o);
    const cur = appState.ghTarget;
    box.innerHTML = `
        <div class="gh-list">${lectures.map((lec, i) => {
            const decks = [...lec.decks.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
            const here = cur && cur.c === o.c && cur.t === o.t && cur.lecture === lec.name;
            return `<div class="gh-lecture${here ? ' is-current' : ''}" data-i="${i}">
                <div class="gh-lecture-head"><span class="gh-lecture-name">${esc(lec.name)}</span>
                    ${mode === 'save' ? `<button type="button" class="gh-btn gh-btn--primary gh-btn--sm" data-save-here>${ICON.save}Save here</button>`
                        : `<button type="button" class="gh-link" data-add title="Add a PDF or ZIP from this computer to this lecture">${ICON.plus}Add a deck</button>`}</div>
                ${mode === 'open' ? (decks.length ? decks.map(([base, d]) => `
                    <div class="gh-deck" data-base="${esc(base)}">
                        <span class="gh-deck-name">${ICON.deck}<span>${esc(base)}</span></span>
                        <span class="gh-deck-acts">
                            ${d.saved ? `<button type="button" class="gh-btn gh-btn--primary gh-btn--sm" data-resume title="Open your last save, at the slide you were on">${ICON.play}Resume<small data-when></small></button>` : ''}
                            ${d.original ? `<button type="button" class="gh-btn gh-btn--sm" data-orig title="${d.saved ? 'Open the original, without your saved changes (they stay on GitHub until you next save)' : 'Open it'}">${d.saved ? `${ICON.reset}Start over` : `${ICON.play}Open`}</button>` : ''}
                        </span>
                    </div>`).join('') : '<p class="gh-muted gh-small">No presentation in this lecture yet.</p>') : ''}
            </div>`;
        }).join('') || `<p class="gh-muted">No lectures in ${esc(o.c)}/${esc(o.t)} yet.</p>`}</div>
        <div class="gh-newlec"${ctxt.adding === 'new' ? '' : ' hidden'}>
            <label class="gh-field"><span>New lecture</span><input data-name placeholder="e.g. 05 - Binary Arithmetic" spellcheck="false"></label>
            <p class="gh-row gh-row--end"><button type="button" class="gh-btn" data-cancel>Cancel</button>
                ${mode === 'save' ? `<button type="button" class="gh-btn gh-btn--primary" data-new-save>${ICON.save}Save here</button>`
                    : `<button type="button" class="gh-btn gh-btn--primary" data-new-file>Choose a PDF or ZIP…</button>`}</p>
            <p class="gh-err" data-new-err></p>
        </div>
        <p class="gh-row"${ctxt.adding === 'new' ? ' hidden' : ''}><button type="button" class="gh-btn" data-new>${ICON.plus}New lecture</button></p>`;

    // Saved times, filled in as they arrive.
    lectures.forEach((lec, i) => lec.decks.forEach((d, base) => {
        if (!d.saved) return;
        L.lastChanged(G.pair.priv, d.saved.path).then(when => {
            const el = box.querySelector(`.gh-lecture[data-i="${i}"] .gh-deck[data-base="${CSS.escape(base)}"] [data-when]`);
            if (el && when) el.textContent = ` · ${fmtWhen(when)}`;
        });
    }));

    box.querySelectorAll('.gh-lecture').forEach(el => {
        const lec = lectures[Number(el.dataset.i)];
        el.querySelectorAll('.gh-deck').forEach(row => {
            const base = row.dataset.base, d = lec.decks.get(base);
            const target = { c: o.c, t: o.t, lecture: lec.name, deck: base, original: d.original?.path || null };
            row.querySelector('[data-resume]')?.addEventListener('click', () => openDeck(target, d.saved, 'zip', { resumed: true }));
            row.querySelector('[data-orig]')?.addEventListener('click', () => openDeck(target, d.original, extOf(d.original.path), { fresh: !!d.saved }));
        });
        el.querySelector('[data-add]')?.addEventListener('click', () => addDeck(o, lec.name));
        el.querySelector('[data-save-here]')?.addEventListener('click', () => chooseForSave(o, lec.name));
    });

    const newBox = box.querySelector('.gh-newlec');
    const name = box.querySelector('[data-name]');
    if (ctxt.adding === 'new') { name.value = mode === 'save' ? (appState.deckName || '') : ''; setTimeout(() => name.focus(), 0); }
    box.querySelector('[data-new]').onclick = () => { ctxt.adding = 'new'; drawLectures(ctxt, o); };
    box.querySelector('[data-cancel]').onclick = () => { ctxt.adding = null; drawLectures(ctxt, o); };
    const named = () => {
        const n = L.cleanName(name.value);
        if (n && o.lectures.has(n)) { newBox.querySelector('[data-new-err]').textContent = `${o.c}/${o.t} already has a lecture called “${n}”.`; return null; }
        return n;
    };
    box.querySelector('[data-new-file]')?.addEventListener('click', () => {
        const n = named(); if (n === null) return;
        addDeck(o, n || null);
    });
    box.querySelector('[data-new-save]')?.addEventListener('click', () => {
        const n = named(); if (n === null) return;
        if (!n) { newBox.querySelector('[data-new-err]').textContent = 'Name the lecture first.'; return; }
        chooseForSave(o, n);
    });
}

/* Open a deck from GitHub. */
async function openDeck(target, entry, kind, { resumed = false, fresh = false } = {}) {
    loading('Opening…', `${target.lecture}: downloading from GitHub`);
    try {
        const bytes = await L.readBlob(G.pair.priv, entry.sha);
        const isPdf = kind === 'pdf';
        const file = new File([bytes], `${target.deck}.${isPdf ? 'pdf' : 'zip'}`, { type: isPdf ? 'application/pdf' : 'application/zip' });
        appState.pendingGhTarget = { ...target, resumed };
        window.BeamerModal?.close();
        openPresentationFile(file);
        if (fresh) toast('Opened the original. Your saved copy stays on GitHub until you save again.');
    } catch (e) {
        appState.pendingGhTarget = null;
        window.BeamerModal?.close();
        showError('Couldn’t open it', e);
    }
}

/* Add a deck from this computer to a lecture (a new one when `lecture` is new or null). */
function addDeck(o, lecture) {
    pickFile('.pdf,.zip,application/pdf,application/zip', async (file) => {
        const kind = extOf(file.name);
        if (kind !== 'pdf' && kind !== 'zip') return showError('Can’t add that file', new Error(`“${file.name}” isn’t a PDF or a Beamer+ ZIP.`));
        if (file.size > L.MAX_BYTES) return showError('Too large for GitHub', new Error(`${file.name} is ${formatSize(file.size)}; GitHub doesn’t accept files over 100 MB.`));
        const deck = L.cleanName(file.name.replace(/\.(zip|pdf)$/i, '')) || 'presentation';
        const lec = lecture || deck;
        const path = `${L.lectureDir(o.c, o.t, lec)}/${deck}.${kind}`;
        const exists = o.lectures.get(lec)?.decks.get(deck)?.original;
        if (exists && !(await confirmBox('Replace it?', `${lec} already has “${deck}”. Replace its original with this file? (Your saved copy, if any, stays.)`, 'Replace'))) return;
        loading('Adding to GitHub…', `${lec}: ${file.name}`);
        try {
            await L.commitFiles(G.pair.priv, [{ path, blob: file }], `Beamer+: add ${deck} to ${o.c}/${o.t} ${lec}`, setLoading);
            G.lib = null;
            appState.pendingGhTarget = { c: o.c, t: o.t, lecture: lec, deck, original: path };
            window.BeamerModal?.close();
            openPresentationFile(file);
            toast(`Added to ${o.c}/${o.t} › ${lec}.`);
        } catch (e) {
            appState.pendingGhTarget = null;
            window.BeamerModal?.close();
            showError('Couldn’t add it', e);
        }
    });
}

/* In save mode: this lecture is where the open deck goes. */
function chooseForSave(o, lecture) {
    const deck = L.cleanName(appState.deckName) || 'presentation';
    const existing = o.lectures.get(lecture)?.decks.get(deck);
    // A deck opened from this computer goes up with its original, so Start over works later.
    appState.ghTarget = { c: o.c, t: o.t, lecture, deck, original: existing?.original ? existing.original.path : null, needsOriginal: !existing?.original };
    updateTitle();
    openSaveDialog();
}

/* ─── save ────────────────────────────────────────────────────── */

async function openSaveDialog() {
    if (!appState.zipFile) return showError('Nothing to save', new Error('No presentation loaded.'));
    if (!signedIn()) return showError('Not signed in', new Error('Sign in with GitHub on the start page to save there.'));
    try { if (!(await ensurePair())) return openLibrary({ mode: 'save' }); }
    catch (e) { return showError('GitHub', e); }
    const t = appState.ghTarget;
    if (!t) return openLibrary({ mode: 'save' });

    const key = `${t.c}/${t.t}/${t.lecture}`;
    let recs = [];
    try { recs = await listRecordings(); } catch { /* none */ }
    const pub = L.twoRepos(G.pair) ? G.pair.pub : G.pair.priv;
    const mine = recs.filter(r => r.lecture === key), others = recs.filter(r => r.lecture !== key);
    const recRow = (r, on) => {
        const done = r.uploaded && r.uploaded.repo === pub.full_name;
        const big = (r.size || 0) > L.MAX_BYTES;
        const when = new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const note = done ? 'already on GitHub' : big ? 'over GitHub’s 100 MB limit' : '';
        return `<label class="gh-check${done || big ? ' is-off' : ''}"><input type="checkbox" data-rec="${esc(r.id)}"${on && !done && !big ? ' checked' : ''}${done || big ? ' disabled' : ''}>
            <span><b>${esc(r.label)}</b> <span class="gh-muted">${esc([r.deckName, when, formatDuration(r.durationMs || 0), formatSize(r.size || 0)].filter(Boolean).join(' · '))}</span>${note ? ` <em>${note}</em>` : ''}</span></label>`;
    };
    const root = document.createElement('div');
    root.className = 'gh-save';
    root.innerHTML = `
        <p class="gh-target">${ICON.gh}<span><b>${esc(t.c)}/${esc(t.t)} › ${esc(t.lecture)}</b><br><span class="gh-muted">${esc(t.deck)}</span></span>
            <button type="button" class="gh-link" data-move>Change</button></p>
        <label class="gh-check"><input type="checkbox" data-deck checked><span><b>Presentation</b> <span class="gh-muted">opens at this slide next time · ${ICON.lock} ${esc(G.pair.priv.name)}</span></span></label>
        <label class="gh-check"><input type="checkbox" data-notes${wantNotes() ? ' checked' : ''}><span><b>Notes PDF</b> <span class="gh-muted">annotations and widgets drawn in · ${pub.private ? ICON.lock : ICON.globe} ${esc(pub.name)}</span></span></label>
        ${recs.length || isRecording() ? `<div class="gh-recs"><div class="gh-recs-head">Recordings <span class="gh-muted">· ${pub.private ? ICON.lock : ICON.globe} ${esc(pub.name)}</span></div>
            ${mine.map(r => recRow(r, true)).join('')}${others.map(r => recRow(r, false)).join('')}
            ${isRecording() ? '<p class="gh-muted gh-small">A recording is in progress: stop it to include it.</p>' : ''}</div>` : ''}`;
    root.querySelector('[data-move]').onclick = () => openLibrary({ mode: 'save' });
    window.BeamerModal?.show({
        kind: 'info', title: 'Save to GitHub', body: root,
        buttons: [
            { label: 'Cancel', kind: 'cancel' },
            { label: 'Save', kind: 'ok', onClick: () => {
                const deck = root.querySelector('[data-deck]').checked;
                const notes = root.querySelector('[data-notes]').checked;
                try { localStorage.setItem(NOTES_KEY, notes ? '1' : '0'); } catch { /* ignore */ }
                const ids = [...root.querySelectorAll('[data-rec]:checked')].map(x => x.dataset.rec);
                if (!deck && !notes && !ids.length) return;
                setTimeout(() => saveNow({ deck, notes, recordings: ids }), 0);
            } },
        ],
    });
    window.BeamerModal?.open?.querySelector('.custom-modal-content')?.classList.add('gh-modal');
}

let saving = false;
async function saveNow({ deck = true, notes, recordings }) {
    const t = appState.ghTarget;
    if (!t || saving) return;
    saving = true;
    document.body.classList.add('gh-saving');
    loading('Saving to GitHub…', 'Building the presentation…');
    try {
        if (!(await ensurePair())) throw new GhError(0, 'Choose your course repository first.');
        bus.emit('annotations:flush');
        const privFiles = [], pubFiles = [];
        if (deck) {
            const zip = await buildPresentationZip({
                extra: { 'config/resume.json': JSON.stringify({ slide: appState.currentSlide, savedAt: new Date().toISOString() }) },
            });
            privFiles.push({ path: L.savedPath(t), blob: zip });
        }
        if (t.needsOriginal && appState.sourceFile) {
            const ext = extOf(appState.sourceFile.name) === 'pdf' ? 'pdf' : 'zip';
            const path = `${L.lectureDir(t.c, t.t, t.lecture)}/${t.deck}.${ext}`;
            privFiles.push({ path, blob: appState.sourceFile });
            t.original = path;
        }
        if (notes) {
            setLoading('Building the notes PDF…');
            pubFiles.push({ path: L.notesPath(t), blob: await buildNotesPdf() });
        }
        const uploaded = [];
        for (const id of recordings) {
            const r = await getRecording(id);
            if (!r || r.blob.size > L.MAX_BYTES) continue;
            const path = L.recordingPath(t, r.meta.startedAt, extOf(r.meta.fileName) || 'webm');
            pubFiles.push({ path, blob: r.blob });
            uploaded.push({ id, path });
        }
        const msg = `Beamer+: save ${t.c}/${t.t} ${t.lecture}`;
        const pub = L.twoRepos(G.pair) ? G.pair.pub : null;
        if (pub) {
            if (privFiles.length) await L.commitFiles(G.pair.priv, privFiles, msg, setLoading);
            if (pubFiles.length) await L.commitFiles(pub, pubFiles, msg, setLoading);
        } else {
            await L.commitFiles(G.pair.priv, [...privFiles, ...pubFiles], msg, setLoading);
        }
        const repo = (pub || G.pair.priv).full_name;
        for (const u of uploaded) await updateRecording(u.id, { uploaded: { repo, path: u.path, at: Date.now() } });
        t.needsOriginal = false;
        G.lib = null;
        window.BeamerModal?.close();
        const extra = [notes && (deck ? 'notes' : 'the notes'), uploaded.length && `${uploaded.length} recording${uploaded.length > 1 ? 's' : ''}`].filter(Boolean);
        toast(`Saved to ${t.c}/${t.t} › ${t.lecture}${extra.length ? `, with ${extra.join(' and ')}` : ''}.`);
    } catch (e) {
        console.error('[github] save failed', e);
        window.BeamerModal?.close();
        showError('Save to GitHub failed', e);
    } finally {
        saving = false;
        document.body.classList.remove('gh-saving');
    }
}
