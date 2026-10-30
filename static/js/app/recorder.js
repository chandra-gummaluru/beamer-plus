// Lecture recorder — records this tab (slides, ink, widgets) with optional
// microphone and tab sound, and keeps every take until it is saved with
// the presentation (library/ui.js).
//
//   ● Record button (bottom-right) → options dialog → browser's share picker
//   ● Recording bar (replaces the record button) → timer, pause / resume, stop
//
// Takes are written to IndexedDB a second at a time while recording, so a
// reload or a crashed tab loses at most the last second. If IndexedDB is not
// available (private window, quota), chunks are kept in memory instead.
//
// A long take is split into parts (PART_BYTES each at most), each a complete
// file of its own, so no single file gets unwieldy to save or upload.

import { getSessionId } from './session.js';

const PREFS_KEY = 'beamer-recorder-prefs';
const TIMESLICE_MS = 1000;
const VIDEO_BPS = 3_000_000;
const AUDIO_BPS = 128_000;
// Takes are split into parts of at most ~PART_BYTES, so no one file gets too
// big to save, upload or play comfortably. A new part starts at ROTATE_AT.
const PART_BYTES = 45e6;
const ROTATE_AT = 40e6;

let appState = null;
let active = null;              // the take in progress, or null

/* ─── public API ──────────────────────────────────────────────── */

export function initRecorder(state) {
    appState = state;
    initRecordButton();
    if (!recordingSupported()) {
        const btn = document.getElementById('record-btn');
        if (btn) btn.title = 'Recording is not supported in this browser';
    }

    window.addEventListener('beforeunload', (e) => {
        if (!active) return;
        // Chunks are already saved, but the last second and the take's end
        // would be cut off — ask first.
        e.preventDefault();
        e.returnValue = '';
    });

    // A take left "recording" by a reload or crash is closed out as-is.
    recoverInterrupted().catch(err => console.warn('[recorder] recovery failed', err));
}

/** Can this browser record the tab? */
const recordingSupported = () => !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== 'undefined';

/* While a take is going, the Record button is its timer: it shows the
   time; a click pauses or resumes; holding it (HOLD_MS) stops the take.
   The hold fills the button with yellow as it counts. Keyboard: Enter or
   Space pauses; holding either key stops, the same way. */
const HOLD_MS = 800;
function initRecordButton() {
    const btn = document.getElementById('record-btn');
    if (!btn) return;
    let holdTimer = null, held = false;
    // A press that began during a take must not also count as a click on
    // plain Record once the take has stopped (that reopened the dialog).
    let swallowClick = false, swallowReset = null;
    const startHold = () => {
        if (!active || active.stopping) return;
        clearTimeout(swallowReset);   // an earlier press's reset mustn't land mid-hold
        swallowClick = true;
        held = false;
        btn.classList.add('is-holding');
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
            held = true;
            btn.classList.remove('is-holding');
            stopRecording();
        }, HOLD_MS);
    };
    const endHold = (fire) => {
        if (!btn.classList.contains('is-holding') && !held) return;
        clearTimeout(holdTimer);
        btn.classList.remove('is-holding');
        if (!held && fire) togglePause();
        held = false;
        swallowReset = setTimeout(() => { swallowClick = false; }, 400);   // the click, if any, comes before this
    };
    btn.addEventListener('pointerdown', (e) => {
        if (!active || e.button !== 0) return;
        e.preventDefault();
        btn.setPointerCapture?.(e.pointerId);
        startHold();
    });
    btn.addEventListener('pointerup', () => endHold(true));
    btn.addEventListener('pointercancel', () => endHold(false));
    btn.addEventListener('lostpointercapture', () => endHold(false));
    btn.addEventListener('keydown', (e) => {
        if (!active || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        if (!e.repeat) startHold();
    });
    btn.addEventListener('keyup', (e) => {
        if (!active || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        endHold(true);
    });
    // Not recording: Record opens the start dialog.
    btn.addEventListener('click', (e) => {
        if (active || swallowClick) { swallowClick = false; e.preventDefault(); return; }
        openRecorder();
    });
}

function paintRecordButton() {
    const btn = document.getElementById('record-btn');
    if (!btn) return;
    const label = btn.querySelector('span');
    const a = active;
    btn.classList.toggle('is-live', !!a && !a.paused && !a.stopping);
    btn.classList.toggle('is-paused', !!a && a.paused && !a.stopping);
    btn.classList.toggle('is-stopping', !!a?.stopping);
    if (!a) {
        if (label) label.textContent = 'Record';
        // Back to plain Record: disabled again if the editor is open.
        btn.disabled = document.body.classList.contains('edit-mode');
        btn.title = recordingSupported() ? 'Record This Tab' : 'Recording is not supported in this browser';
        btn.removeAttribute('aria-pressed');
        return;
    }
    if (label) label.textContent = a.stopping ? 'Saving' : formatDuration(elapsed(a));
    btn.title = a.stopping ? 'Saving the recording'
        : a.paused ? 'Paused — click to resume, hold to stop'
        : 'Recording — click to pause, hold to stop';
    btn.setAttribute('aria-pressed', String(!a.paused));
}

/** The record button: the recorder's start dialog. */
function openRecorder() {
    if (active) return;
    openStartDialog();
}

/** True while a take is in progress (recording or paused). */
export function isRecording() { return !!active; }

/** Every finished take, newest first. */
export async function listRecordings() {
    const all = await store.allMeta();
    return all
        .filter(m => !(active && m.status === 'recording'))
        .sort((a, b) => b.startedAt - a.startedAt);
}

export async function downloadRecording(id) {
    const meta = (await store.allMeta()).find(m => m.id === id);
    if (!meta) return;
    const blob = new Blob(await store.chunks(id), { type: meta.mimeType });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: meta.fileName });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A finished take as one Blob, with its saved details. */
export async function getRecording(id) {
    const meta = (await store.allMeta()).find(m => m.id === id);
    if (!meta) return null;
    return { meta, blob: new Blob(await store.chunks(id), { type: meta.mimeType }) };
}

/** Add details to a take (Save notes where it saved it). */
export async function updateRecording(id, patch) {
    const meta = (await store.allMeta()).find(m => m.id === id);
    if (!meta) return;
    await store.putMeta({ ...meta, ...patch });
}

/* ─── start dialog ────────────────────────────────────────────── */

function loadPrefs() {
    const def = { mic: true, sound: true };
    try { return { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
    catch { return def; }
}
function savePrefs(p) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

function openStartDialog() {
    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
        window.BeamerModal?.show({
            kind: 'error',
            title: 'Recording Not Available',
            message: window.isSecureContext
                ? 'This browser cannot record the screen. Use a recent Chrome, Edge or Firefox.'
                : 'Screen recording needs a secure (https://) connection. Open Beamer+ through the https:// address the launcher prints.',
        });
        return;
    }
    const prefs = loadPrefs();
    const body = document.createElement('div');
    body.className = 'recorder-options';
    body.innerHTML = `
        <label class="slide-setting">
            <span class="slide-setting-text">
                <span class="slide-setting-name">Microphone</span>
                <span class="slide-setting-desc">Your voice</span>
            </span>
            <input type="checkbox" class="editor-switch" role="switch" id="rec-opt-mic">
        </label>
        <label class="slide-setting">
            <span class="slide-setting-text">
                <span class="slide-setting-name">Computer Sound</span>
                <span class="slide-setting-desc">Videos, audio clips and widgets</span>
            </span>
            <input type="checkbox" class="editor-switch" role="switch" id="rec-opt-sound">
        </label>
        <p class="recorder-hint"></p>`;
    body.querySelector('#rec-opt-mic').checked = !!prefs.mic;
    body.querySelector('#rec-opt-sound').checked = !!prefs.sound;

    const hint = body.querySelector('.recorder-hint');
    const read = () => ({
        mic:    body.querySelector('#rec-opt-mic').checked,
        sound:  body.querySelector('#rec-opt-sound').checked,
    });
    const updateHint = () => {
        hint.textContent = read().sound
            ? 'Records this tab. When your browser asks, allow it and leave “Also share tab audio” on.'
            : 'Records this tab. When your browser asks, allow it.';
    };
    body.addEventListener('change', updateHint);
    updateHint();

    window.BeamerModal?.show({
        kind: 'info',
        title: 'Record',
        body,
        buttons: [
            { label: 'Cancel', kind: 'cancel' },
            // Called straight from the click so the share picker still has
            // the user gesture it requires.
            { label: 'Start Recording', kind: 'ok', onClick: () => {
                const o = read();
                savePrefs(o);
                startRecording(o);
            } },
        ],
    });
}

/* ─── recording ───────────────────────────────────────────────── */

// H.264 MP4 first (plays everywhere, seekable); otherwise WebM. A generic
// "video/mp4" without H.264 (VP9-in-MP4) is a last resort — few players take it.
function pickMimeType(hasAudio) {
    const list = hasAudio
        ? ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2',
           'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
        : ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1',
           'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    return list.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
}

function stopTracks(stream) { stream?.getTracks().forEach(t => t.stop()); }

async function startRecording({ mic, sound }) {
    if (active) return;

    // 1 — the screen. Must be the first await after the click.
    let display;
    try {
        const opts = {
            video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: sound ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false,
                             suppressLocalAudioPlayback: false } : false,
            // Always this tab: offer it first, and nothing but browser tabs.
            preferCurrentTab: true,
            selfBrowserSurface: 'include',
            surfaceSwitching: 'exclude',
            monitorTypeSurfaces: 'exclude',
            systemAudio: 'exclude',
        };
        opts.video.displaySurface = 'browser';
        display = await navigator.mediaDevices.getDisplayMedia(opts);
    } catch (err) {
        if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return; // picker cancelled
        showError('Could not start recording', err);
        return;
    }

    // Browsers without preferCurrentTab (Firefox, Safari) still let you
    // pick a screen or window: only a browser tab is accepted.
    const surface = display.getVideoTracks()[0]?.getSettings?.().displaySurface;
    if (surface && surface !== 'browser') {
        stopTracks(display);
        window.BeamerModal?.show({
            kind: 'warning',
            title: 'Choose This Tab',
            message: 'Beamer+ records only its own tab. Start again and pick this tab when your browser asks.',
        });
        return;
    }

    // 2 — the microphone.
    let micStream = null;
    if (mic) {
        try {
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
        } catch (err) {
            const goOn = await confirmNoMic(err);
            if (!goOn) { stopTracks(display); return; }
        }
    }

    // 3 — mix the sound sources into one track.
    const displayAudio = display.getAudioTracks();
    const sources = [];
    if (displayAudio.length) sources.push(new MediaStream(displayAudio));
    if (micStream) sources.push(micStream);

    const tracks = [...display.getVideoTracks()];
    let audioCtx = null;
    if (sources.length) {
        audioCtx = new AudioContext();
        const dest = audioCtx.createMediaStreamDestination();
        for (const s of sources) audioCtx.createMediaStreamSource(s).connect(dest);
        try { await audioCtx.resume(); } catch { /* resumes on its own */ }
        tracks.push(dest.stream.getAudioTracks()[0]);
    }
    const stream = new MediaStream(tracks);

    // 4 — the recorder. A take is written as one or more parts: each part is
    // its own complete, playable file, and a new one starts (seamlessly, see
    // rotatePart) before it passes PART_BYTES.
    const mimeType = pickMimeType(sources.length > 0);
    const recOpts = {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: VIDEO_BPS,
        audioBitsPerSecond: AUDIO_BPS,
    };
    let probe;
    try { probe = new MediaRecorder(stream, recOpts); }
    catch {
        try { probe = new MediaRecorder(stream); }
        catch (err) {
            stopTracks(display); stopTracks(micStream); audioCtx?.close();
            showError('Could not start recording', err);
            return;
        }
    }

    const finalType = (probe.mimeType || mimeType || 'video/webm').split(';')[0];
    const startedAt = Date.now();
    const sessionId = getSessionId();
    // Number takes, not parts: count the distinct takes of this session.
    const groups = new Set((await store.allMeta()).filter(m => m.sessionId === sessionId).map(m => m.group || m.id));
    const number = groups.size + 1;
    const deck = (appState?.deckName || 'Beamer+').trim();

    active = {
        group: `rec-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
        stream, display, micStream, audioCtx, recOpts,
        ext: finalType.includes('mp4') ? 'mp4' : 'webm',
        finalType, number, deck, sessionId, startedAt,
        hasMic: !!micStream, hasSound: displayAudio.length > 0,
        // Where the deck came from ("<folder>/<name>", see library/ui.js
        // targetKey), so Save presentation offers this take with it.
        lecture: appState?.target ? [appState.target.dir, appState.target.name].filter(Boolean).join('/') : null,
        part: null, partCount: 0, doneMs: 0, closing: [],
        paused: false, timer: null, stopping: null,
    };
    try { await startPart(active, probe); }
    catch (err) {
        const a = active; active = null;
        stopTracks(a.display); stopTracks(a.micStream); a.audioCtx?.close();
        showError('Could not start recording', err);
        return;
    }

    // "Stop sharing" in the browser's own bar ends the take too.
    display.getVideoTracks()[0]?.addEventListener('ended', () => stopRecording());

    showBar();

    if (sound && !displayAudio.length) {
        toast('No tab sound: “Also share tab audio” was off. Stop and start again to include it.');
    }
}

function partName(a, n, t) {
    const part = n > 1 || a.partCount > 1 ? ` part ${n}` : '';
    return {
        label: `Recording ${a.number}${part ? ` · part ${n}` : ''}`,
        fileName: `${safeName(a.deck)} - recording ${a.number}${part} (${stamp(t)}).${a.ext}`,
    };
}

/** Start the next part of take a (with mr, if one is already made). */
async function startPart(a, mr = null) {
    if (!mr) {
        try { mr = new MediaRecorder(a.stream, a.recOpts); }
        catch { mr = new MediaRecorder(a.stream); }
    }
    const n = ++a.partCount;
    const t = Date.now();
    const meta = {
        id: `${a.group}-p${n}`,
        group: a.group,
        part: n,
        groupStartedAt: a.startedAt,
        sessionId: a.sessionId,
        deckName: a.deck,
        ...partName(a, n, t),
        mimeType: a.finalType,
        startedAt: t,
        durationMs: 0,
        size: 0,
        status: 'recording',
        hasMic: a.hasMic,
        hasSound: a.hasSound,
        lecture: a.lecture,
    };
    const p = { id: meta.id, meta, mr, seq: 0, writes: Promise.resolve(),
                activeMs: 0, resumedAt: performance.now(), closed: null };
    await store.putMeta(meta);
    if (a.stopping) {                  // stopped while this part was being set up
        await store.remove(meta.id);
        throw new Error('The recording was stopped.');
    }

    mr.addEventListener('dataavailable', (e) => {
        if (!e.data || !e.data.size) return;
        const seq = p.seq++;
        p.meta.size += e.data.size;
        if (!p.closed) p.meta.durationMs = Math.round(partElapsed(a, p));
        const data = e.data;
        p.writes = p.writes
            .then(() => store.addChunk(p.id, seq, data))
            .then(() => store.putMeta({ ...p.meta }))
            .catch(err => console.warn('[recorder] chunk write failed', err));
        // Nearly full: carry on in a new part.
        if (a === active && a.part === p && !a.paused && !a.stopping && p.meta.size >= ROTATE_AT) rotatePart(a);
    });
    mr.addEventListener('error', (e) => {
        console.error('[recorder] MediaRecorder error', e.error || e);
        if (a === active && a.part === p) stopRecording();
    });
    a.part = p;
    mr.start(TIMESLICE_MS);
    if (a.paused) mr.pause();
}

// The new part starts before the old one stops, so nothing is missed
// between them (at most a few frames appear at the end of one and the start
// of the next).
async function rotatePart(a) {
    const old = a.part;
    if (old.rotating) return;
    old.rotating = true;
    if (a.partCount === 1) Object.assign(old.meta, partName({ ...a, partCount: 2 }, 1, old.meta.startedAt));
    try { await startPart(a); }
    catch (err) {
        console.warn('[recorder] could not start the next part; this one carries on', err);
        old.rotating = false;
        return;
    }
    a.doneMs += partElapsed(a, old);
    a.closing.push(closePart(a, old));
}

/** Stop part p's recorder; resolves once all of it is saved. */
function closePart(a, p) {
    if (p.closed) return p.closed;
    p.closed = new Promise((resolve) => {
        if (!a.paused) p.activeMs += performance.now() - p.resumedAt;
        p.frozenMs = p.activeMs;
        const finish = async () => {
            try { await p.writes; } catch { /* logged already */ }
            p.meta.durationMs = Math.round(p.frozenMs);
            p.meta.status = 'done';
            try { await store.putMeta({ ...p.meta }); } catch (err) { console.warn('[recorder]', err); }
            resolve();
        };
        if (p.mr.state === 'inactive') { finish(); return; }
        p.mr.addEventListener('stop', () => { setTimeout(finish, 0); }, { once: true });
        try { p.mr.stop(); } catch { finish(); }
    });
    return p.closed;
}

function partElapsed(a, p) {
    if (p.frozenMs != null) return p.frozenMs;
    return p.activeMs + (a.paused ? 0 : performance.now() - p.resumedAt);
}

function togglePause() {
    const a = active;
    if (!a || a.stopping) return;
    const p = a.part;
    if (a.paused) {
        p.mr.resume();
        p.resumedAt = performance.now();
        a.paused = false;
    } else {
        p.mr.pause();
        p.activeMs += performance.now() - p.resumedAt;
        a.paused = true;
        p.mr.requestData?.();   // save what we have now
    }
    renderBar();
}

/** Ends the take in progress. Resolves once it is fully saved. */
export function stopRecording() {
    const a = active;
    if (!a) return Promise.resolve();
    if (a.stopping) return a.stopping;
    a.stopping = (async () => {
        renderBar();
        await Promise.all([...a.closing, closePart(a, a.part)]);
        a.paused = true;
        stopTracks(a.display);
        stopTracks(a.micStream);
        try { await a.audioCtx?.close(); } catch { /* already closed */ }
        if (active === a) active = null;
        hideBar();
        toast(a.partCount > 1
            ? `Recording ${a.number} saved in ${a.partCount} parts — find them under Download.`
            : `Recording ${a.number} saved — find it under Download.`);
    })();
    renderBar();
    return a.stopping;
}

function elapsed(a) {
    return a.doneMs + partElapsed(a, a.part);
}

/* ─── the take's timer (the Record button) ───────────────────────── */

function showBar() {
    document.body.classList.add('is-recording');
    renderBar();
    clearInterval(active?.timer);
    if (active) active.timer = setInterval(renderBar, 250);
}

function hideBar() {
    document.body.classList.remove('is-recording');
    paintRecordButton();
}

function renderBar() {
    const a = active;
    if (!a) return;
    if (a.stopping) clearInterval(a.timer);
    paintRecordButton();
}

let toastTimer = null;
function toast(text) {
    let el = document.getElementById('recorder-toast');
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

function confirmNoMic(err) {
    return new Promise((resolve) => {
        let answered = false;
        const done = (v) => { if (!answered) { answered = true; resolve(v); } };
        window.BeamerModal?.show({
            kind: 'warning',
            title: 'Microphone Unavailable',
            message: `${err?.name === 'NotAllowedError' ? 'Microphone access was blocked.' : 'No microphone could be opened.'} Record without your voice?`,
            buttons: [
                { label: 'Cancel', kind: 'cancel', onClick: () => done(false) },
                { label: 'Record Without Microphone', kind: 'ok', onClick: () => done(true) },
            ],
            canClose: () => { done(false); return true; },
        });
        // Closed some other way (Escape)? Treat as Cancel.
        const overlay = window.BeamerModal?.open;
        if (!overlay) { done(false); return; }
        const mo = new MutationObserver(() => {
            if (!overlay.isConnected) { mo.disconnect(); done(false); }
        });
        mo.observe(document.body, { childList: true });
    });
}

function showError(title, err) {
    console.error('[recorder]', err);
    window.BeamerModal?.show({ kind: 'error', title, message: err?.message || String(err) });
}

/* ─── formatting ──────────────────────────────────────────────── */

function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function formatSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function stamp(t) {
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

function safeName(s) {
    return s.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'Beamer+';
}

/* ─── storage: IndexedDB, falling back to memory ──────────────── */

async function recoverInterrupted() {
    const all = await store.allMeta();
    for (const m of all) {
        if (m.status !== 'recording') continue;
        if (active && m.group === active.group) continue;
        const chunks = await store.chunks(m.id);
        if (!chunks.length) { await store.remove(m.id); continue; }
        m.status = 'done';
        m.recovered = true;
        await store.putMeta(m);
    }
}

const store = (() => {
    const DB = 'beamer-recordings';
    const mem = { meta: new Map(), chunks: new Map() };   // fallback
    let dbp = null;

    function open() {
        if (dbp) return dbp;
        dbp = new Promise((resolve) => {
            let req;
            try { req = indexedDB.open(DB, 1); } catch { resolve(null); return; }
            req.onupgradeneeded = () => {
                const db = req.result;
                db.createObjectStore('meta', { keyPath: 'id' });
                db.createObjectStore('chunks', { autoIncrement: true }).createIndex('recId', 'recId');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => { console.warn('[recorder] IndexedDB unavailable; keeping takes in memory'); resolve(null); };
            req.onblocked = () => resolve(null);
        });
        return dbp;
    }

    const done = (tx) => new Promise((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
    });
    const result = (req) => new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });

    function memChunks(id) {
        if (!mem.chunks.has(id)) mem.chunks.set(id, []);
        return mem.chunks.get(id);
    }

    return {
        async putMeta(meta) {
            const db = await open();
            if (!db) { mem.meta.set(meta.id, meta); return; }
            try {
                const tx = db.transaction('meta', 'readwrite');
                tx.objectStore('meta').put(meta);
                await done(tx);
            } catch (err) {
                mem.meta.set(meta.id, meta);
                throw err;
            }
        },
        async addChunk(recId, seq, blob) {
            const db = await open();
            if (db) {
                try {
                    const tx = db.transaction('chunks', 'readwrite');
                    tx.objectStore('chunks').add({ recId, seq, blob });
                    await done(tx);
                    return;
                } catch (err) {
                    console.warn('[recorder] could not save to disk, keeping in memory', err);
                }
            }
            memChunks(recId).push({ seq, blob });
        },
        async allMeta() {
            const db = await open();
            const out = new Map();
            if (db) {
                try {
                    const tx = db.transaction('meta', 'readonly');
                    for (const m of await result(tx.objectStore('meta').getAll())) out.set(m.id, m);
                } catch (err) { console.warn('[recorder]', err); }
            }
            for (const [id, m] of mem.meta) out.set(id, m);
            return [...out.values()];
        },
        async chunks(recId) {
            const db = await open();
            let rows = [];
            if (db) {
                const tx = db.transaction('chunks', 'readonly');
                rows = await result(tx.objectStore('chunks').index('recId').getAll(recId));
            }
            rows = rows.concat(mem.chunks.get(recId) || []);
            rows.sort((a, b) => a.seq - b.seq);
            return rows.map(r => r.blob);
        },
        async remove(recId) {
            mem.meta.delete(recId);
            mem.chunks.delete(recId);
            const db = await open();
            if (!db) return;
            const tx = db.transaction(['meta', 'chunks'], 'readwrite');
            tx.objectStore('meta').delete(recId);
            const cur = tx.objectStore('chunks').index('recId').openCursor(IDBKeyRange.only(recId));
            cur.onsuccess = () => {
                const c = cur.result;
                if (c) { c.delete(); c.continue(); }
            };
            await done(tx);
        },
    };
})();
