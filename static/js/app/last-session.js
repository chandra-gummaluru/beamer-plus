// Last Session — the start page's "Last Session" button reopens the
// presentation exactly as you left it: annotations, edits, widget states and
// the slide you were on, saved or not.
//
// While a presentation is open, a copy of it is kept in this browser
// (IndexedDB), refreshed a few seconds after you stop drawing, editing or
// clicking, and when the tab is hidden or the session ends. Moving between
// slides only updates which slide you're on (cheap); anything else rebuilds
// the copy (the same ZIP Save writes, uncompressed).
//
//   'meta'  { sessionId, name, slide, totalSlides, target, savedAt }
//   'deck'  { blob, name, savedAt }
//
// Restoring: the start page goes to /s/<session>/?resume=1 (the last
// session's own code when the server still has it, so audience links keep
// working; otherwise a new one), and this module opens the copy there.

import { bus } from '../core/events.js';
import { getSessionId } from './session.js';

const DB = 'beamer-last-session', STORE = 'kv';
const IDLE_MS = 4000;          // rebuild the copy this long after the last change…
const MAX_WAIT_MS = 30000;     // …but no later than this after the first one

function idb() {
    return new Promise((res) => {
        let req;
        try { req = indexedDB.open(DB, 1); } catch { res(null); return; }
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
    });
}
async function get(key) {
    const db = await idb(); if (!db) return null;
    return new Promise(res => {
        try {
            const r = db.transaction(STORE).objectStore(STORE).get(key);
            r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
        } catch { res(null); }
    });
}
async function put(entries) {
    const db = await idb(); if (!db) return;
    await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        for (const [k, v] of Object.entries(entries)) tx.objectStore(STORE).put(v, k);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
}

/** What Last Session would reopen ({ name, slide, totalSlides, savedAt, sessionId }), or null. */
export async function lastSessionInfo() {
    const [meta, deck] = await Promise.all([get('meta'), get('deck')]);
    return meta && deck?.blob ? meta : null;
}

/* ─── in the presenter ────────────────────────────────────────── */

let appState = null;
let contentDirty = false, metaDirty = false;
let idleTimer = null, firstDirtyAt = 0;
let writing = null;            // the write in progress (a Promise), if any
let restoring = false;

export function initLastSession(state) {
    appState = state;
    window.BeamerLastSession = { flush };

    const params = new URLSearchParams(location.search);
    if (params.has('resume')) {
        params.delete('resume');
        const qs = params.toString();
        history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
        restore();
    }

    // What changes the presentation: drawing, editing, typing, clicking on
    // a widget (focus moving into its frame blurs this window), and the
    // editor's own events. Moving between slides only changes `slide`.
    const touch = () => markDirty(true);
    document.addEventListener('pointerup', touch, true);
    document.addEventListener('keyup', (e) => { if (!isNavKey(e)) touch(); }, true);
    window.addEventListener('blur', touch);
    for (const ev of ['slides:reordered', 'slides:remapped', 'slide:delete', 'editor:exited',
        'bookmarks:changed', 'paper:changed', 'textbox:committed', 'view:ratio-commit', 'library:saved']) bus.on(ev, touch);
    bus.on('deck:loaded', () => { if (restoring) { restoring = false; markDirty(false); } else markDirty(true); });
    bus.on('slide:changed', () => markDirty(false));

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', () => { flush(); });
}

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Shift', 'Control', 'Alt', 'Meta', 'Escape']);
const isNavKey = e => NAV_KEYS.has(e.key);

function markDirty(content) {
    if (!appState?.zipFile) return;
    if (content) contentDirty = true;
    metaDirty = true;
    const now = Date.now();
    if (!firstDirtyAt) firstDirtyAt = now;
    clearTimeout(idleTimer);
    const wait = content ? Math.max(0, Math.min(IDLE_MS, firstDirtyAt + MAX_WAIT_MS - now)) : 800;
    idleTimer = setTimeout(() => { write().catch(() => {}); }, wait);
}

/** Write any pending change now (the session ending, the tab hidden). */
export async function flush() {
    clearTimeout(idleTimer);
    try { await write({ force: true }); } catch { /* best effort */ }
}

async function write({ force = false } = {}) {
    if (writing) { await writing.catch(() => {}); if (!contentDirty && !metaDirty) return; }
    if (!appState?.zipFile || (!contentDirty && !metaDirty)) return;
    // Not mid-save or with a window open (the editor's dialogs, Save itself):
    // try again shortly, unless this is the last chance.
    if (!force && (document.body.classList.contains('lib-saving') || document.querySelector('.custom-modal-overlay'))) {
        idleTimer = setTimeout(() => { write().catch(() => {}); }, IDLE_MS);
        return;
    }
    const content = contentDirty;
    contentDirty = false; metaDirty = false; firstDirtyAt = 0;
    writing = (async () => {
        const now = new Date().toISOString();
        const name = appState.target?.name || appState.deckName || 'presentation';
        const meta = {
            sessionId: getSessionId(),
            name,
            slide: appState.currentSlide || 0,
            totalSlides: appState.totalSlides || 0,
            target: appState.target || null,
            savedAt: now,
        };
        const entries = { meta };
        if (content) {
            const { buildPresentationZip } = await import('../editor/save.js');
            const blob = await buildPresentationZip({
                store: true,
                extra: { 'config/resume.json': JSON.stringify({ slide: meta.slide, savedAt: now }) },
            });
            entries.deck = { blob, name: appState.deckName || name, savedAt: now };
        }
        await put(entries);
    })();
    try { await writing; }
    catch (e) {
        console.warn('[last-session] could not keep a copy', e);
        if (content) contentDirty = true;       // try again next time
    } finally { writing = null; }
}

// Open the kept copy here, where it left off.
async function restore() {
    const [meta, deck] = await Promise.all([get('meta'), get('deck')]);
    if (!deck?.blob) {
        window.BeamerModal?.show({ kind: 'info', title: 'Nothing to reopen', message: 'There’s no earlier session kept in this browser.' });
        return;
    }
    restoring = true;
    appState.pendingTarget = meta?.target || null;
    const slide = Number(meta?.slide) || 0;
    const off = bus.on('deck:loaded', () => {
        off();
        if (slide && slide !== appState.currentSlide && slide < (appState.slideStructure?.length || 0)) {
            setTimeout(() => bus.emit('slide:goto', slide), 0);
        }
    });
    const file = new File([deck.blob], `${deck.name || 'presentation'}.zip`, { type: 'application/zip' });
    // After the splash (main.js fades it out at 1.6 s), like any other open.
    setTimeout(() => bus.emit('upload:zip', file), 300);
}
