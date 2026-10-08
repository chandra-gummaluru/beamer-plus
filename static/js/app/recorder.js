// Lecture recorder — records the screen (this tab, or any screen/window) with
// optional microphone and computer sound, and keeps every take until it is
// downloaded or deleted.
//
//   ● Record button (top-right)  → options dialog → browser's share picker
//   ● Recording bar (top-centre) → timer, pause / resume, stop
//   ● Download menu              → lists every take (download-menu.js)
//
// Takes are written to IndexedDB a second at a time while recording, so a
// reload or a crashed tab loses at most the last second. If IndexedDB is not
// available (private window, quota), chunks are kept in memory instead.

import { getSessionId } from './session.js';

const PREFS_KEY = 'beamer-recorder-prefs';
const TIMESLICE_MS = 1000;
const VIDEO_BPS = 3_000_000;
const AUDIO_BPS = 128_000;

let appState = null;
let active = null;              // the take in progress, or null
const changeListeners = new Set();

/* ─── public API ──────────────────────────────────────────────── */

export function initRecorder(state) {
    appState = state;
    document.getElementById('record-btn')?.addEventListener('click', () => {
        if (active) return;
        openStartDialog();
    });
    document.getElementById('recorder-pause-btn')?.addEventListener('click', togglePause);
    document.getElementById('recorder-stop-btn')?.addEventListener('click', () => stopRecording());

    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
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

/** True while a take is in progress (recording or paused). */
export function isRecording() { return !!active; }

/** Notified whenever the list of takes or the active take changes. */
export function onRecordingsChange(fn) {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
}

/** Every finished take, newest first. */
export async function listRecordings() {
    const all = await store.allMeta();
    return all
        .filter(m => !active || m.id !== active.id)
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

export async function deleteRecording(id) {
    if (active && active.id === id) return;
    await store.remove(id);
    emitChange();
}

/* ─── start dialog ────────────────────────────────────────────── */

function loadPrefs() {
    const def = { source: 'tab', mic: true, sound: true };
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
            title: 'Recording not available',
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
        <div class="recorder-source" role="radiogroup" aria-label="What to record">
            <label class="recorder-source-opt"><input type="radio" name="rec-source" value="tab">
                <span class="recorder-source-title">This tab</span>
                <span class="recorder-source-desc">Slides, ink and widgets</span></label>
            <label class="recorder-source-opt"><input type="radio" name="rec-source" value="screen">
                <span class="recorder-source-title">Screen or window</span>
                <span class="recorder-source-desc">Include other apps</span></label>
        </div>
        <label class="slide-setting">
            <span class="slide-setting-text">
                <span class="slide-setting-name">Microphone</span>
                <span class="slide-setting-desc">Your voice</span>
            </span>
            <input type="checkbox" class="editor-switch" role="switch" id="rec-opt-mic">
        </label>
        <label class="slide-setting">
            <span class="slide-setting-text">
                <span class="slide-setting-name">Computer sound</span>
                <span class="slide-setting-desc">Videos, audio clips and widgets</span>
            </span>
            <input type="checkbox" class="editor-switch" role="switch" id="rec-opt-sound">
        </label>
        <p class="recorder-hint"></p>`;
    body.querySelector(`input[name="rec-source"][value="${prefs.source === 'screen' ? 'screen' : 'tab'}"]`).checked = true;
    body.querySelector('#rec-opt-mic').checked = !!prefs.mic;
    body.querySelector('#rec-opt-sound').checked = !!prefs.sound;

    const hint = body.querySelector('.recorder-hint');
    const read = () => ({
        source: body.querySelector('input[name="rec-source"]:checked')?.value || 'tab',
        mic:    body.querySelector('#rec-opt-mic').checked,
        sound:  body.querySelector('#rec-opt-sound').checked,
    });
    const updateHint = () => {
        const o = read();
        if (o.source === 'tab') {
            hint.textContent = o.sound
                ? 'Your browser will ask what to share: choose this tab and leave “Also share tab audio” on.'
                : 'Your browser will ask what to share: choose this tab.';
        } else {
            hint.textContent = o.sound
                ? 'Your browser will ask what to share: choose a screen and turn on “Also share system audio”.'
                : 'Your browser will ask what to share: choose a screen or window.';
        }
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
            { label: 'Start recording', kind: 'ok', onClick: () => {
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

async function startRecording({ source, mic, sound }) {
    if (active) return;

    // 1 — the screen. Must be the first await after the click.
    let display;
    try {
        const opts = {
            video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: sound ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false,
                             suppressLocalAudioPlayback: false } : false,
            selfBrowserSurface: 'include',
            surfaceSwitching: 'include',
            systemAudio: sound ? 'include' : 'exclude',
        };
        if (source === 'tab') opts.preferCurrentTab = true;
        else opts.video.displaySurface = 'monitor';
        display = await navigator.mediaDevices.getDisplayMedia(opts);
    } catch (err) {
        if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return; // picker cancelled
        showError('Could not start recording', err);
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

    // 4 — the recorder.
    let mr;
    const mimeType = pickMimeType(sources.length > 0);
    try {
        mr = new MediaRecorder(stream, {
            ...(mimeType ? { mimeType } : {}),
            videoBitsPerSecond: VIDEO_BPS,
            audioBitsPerSecond: AUDIO_BPS,
        });
    } catch {
        try { mr = new MediaRecorder(stream); }
        catch (err) {
            stopTracks(display); stopTracks(micStream); audioCtx?.close();
            showError('Could not start recording', err);
            return;
        }
    }

    const finalType = (mr.mimeType || mimeType || 'video/webm').split(';')[0];
    const ext = finalType.includes('mp4') ? 'mp4' : 'webm';
    const startedAt = Date.now();
    const sessionId = getSessionId();
    const existing = (await store.allMeta()).filter(m => m.sessionId === sessionId).length;
    const number = existing + 1;
    const deck = (appState?.deckName || 'Beamer+').trim();

    const meta = {
        id: `rec-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        deckName: deck,
        label: `Recording ${number}`,
        fileName: `${safeName(deck)} - recording ${number} (${stamp(startedAt)}).${ext}`,
        mimeType: finalType,
        startedAt,
        durationMs: 0,
        size: 0,
        status: 'recording',
        hasMic: !!micStream,
        hasSound: displayAudio.length > 0,
    };

    active = {
        id: meta.id, meta, mr, display, micStream, audioCtx,
        seq: 0, writes: Promise.resolve(),
        activeMs: 0, resumedAt: performance.now(), paused: false,
        timer: null, stopping: null,
    };
    await store.putMeta(meta);

    mr.addEventListener('dataavailable', (e) => {
        if (!e.data || !e.data.size || !active) return;
        const a = active;
        const seq = a.seq++;
        a.meta.size += e.data.size;
        a.meta.durationMs = elapsed(a);
        const data = e.data;
        a.writes = a.writes
            .then(() => store.addChunk(a.id, seq, data))
            .then(() => store.putMeta({ ...a.meta }))
            .catch(err => console.warn('[recorder] chunk write failed', err));
    });
    mr.addEventListener('error', (e) => {
        console.error('[recorder] MediaRecorder error', e.error || e);
        stopRecording();
    });
    // "Stop sharing" in the browser's own bar ends the take too.
    display.getVideoTracks()[0]?.addEventListener('ended', () => stopRecording());

    mr.start(TIMESLICE_MS);
    showBar();
    emitChange();

    if (sound && !displayAudio.length) {
        toast(source === 'tab'
            ? 'No computer sound: “Also share tab audio” was off. Stop and start again to include it.'
            : 'No computer sound: system audio wasn’t shared (or isn’t available for this choice).');
    }
}

function togglePause() {
    const a = active;
    if (!a || a.stopping) return;
    if (a.paused) {
        a.mr.resume();
        a.resumedAt = performance.now();
        a.paused = false;
    } else {
        a.mr.pause();
        a.activeMs += performance.now() - a.resumedAt;
        a.paused = true;
        a.mr.requestData?.();   // save what we have now
    }
    renderBar();
}

/** Ends the take in progress. Resolves once it is fully saved. */
export function stopRecording() {
    const a = active;
    if (!a) return Promise.resolve();
    if (a.stopping) return a.stopping;
    a.stopping = new Promise((resolve) => {
        const finish = async () => {
            if (!a.paused) a.activeMs += performance.now() - a.resumedAt;
            a.paused = true;
            try { await a.writes; } catch { /* logged already */ }
            a.meta.durationMs = Math.round(a.activeMs);
            a.meta.status = 'done';
            try { await store.putMeta({ ...a.meta }); } catch (err) { console.warn('[recorder]', err); }
            stopTracks(a.display);
            stopTracks(a.micStream);
            try { await a.audioCtx?.close(); } catch { /* already closed */ }
            if (active === a) active = null;
            hideBar();
            emitChange();
            toast(`${a.meta.label} saved — find it under Download.`);
            resolve();
        };
        if (a.mr.state === 'inactive') { finish(); return; }
        a.mr.addEventListener('stop', () => { setTimeout(finish, 0); }, { once: true });
        try { a.mr.stop(); } catch { finish(); }
    });
    renderBar();
    return a.stopping;
}

function elapsed(a) {
    return a.activeMs + (a.paused ? 0 : performance.now() - a.resumedAt);
}

/* ─── recording bar ───────────────────────────────────────────── */

function showBar() {
    const bar = document.getElementById('recorder-bar');
    if (!bar) return;
    bar.hidden = false;
    document.body.classList.add('is-recording');
    renderBar();
    clearInterval(active?.timer);
    if (active) active.timer = setInterval(renderBar, 250);
}

function hideBar() {
    const bar = document.getElementById('recorder-bar');
    if (bar) { bar.hidden = true; bar.classList.remove('is-paused', 'is-stopping'); }
    document.body.classList.remove('is-recording');
}

function renderBar() {
    const a = active;
    const bar = document.getElementById('recorder-bar');
    if (!a || !bar) return;
    if (a.stopping) clearInterval(a.timer);
    bar.classList.toggle('is-paused', a.paused && !a.stopping);
    bar.classList.toggle('is-stopping', !!a.stopping);
    bar.querySelector('.recorder-state').textContent = a.stopping ? 'Saving' : a.paused ? 'Paused' : 'Rec';
    bar.querySelector('.recorder-time').textContent = formatDuration(elapsed(a));
    const pause = document.getElementById('recorder-pause-btn');
    if (pause) {
        pause.title = a.paused ? 'Resume recording' : 'Pause recording';
        pause.setAttribute('aria-label', pause.title);
        pause.classList.toggle('is-resume', a.paused);
        pause.disabled = !!a.stopping;
    }
    const stop = document.getElementById('recorder-stop-btn');
    if (stop) stop.disabled = !!a.stopping;
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
            title: 'Microphone unavailable',
            message: `${err?.name === 'NotAllowedError' ? 'Microphone access was blocked.' : 'No microphone could be opened.'} Record without your voice?`,
            buttons: [
                { label: 'Cancel', kind: 'cancel', onClick: () => done(false) },
                { label: 'Record without microphone', kind: 'ok', onClick: () => done(true) },
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

function emitChange() {
    for (const fn of changeListeners) { try { fn(); } catch (e) { console.error(e); } }
}

/* ─── formatting ──────────────────────────────────────────────── */

export function formatDuration(ms) {
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
    let changed = false;
    for (const m of all) {
        if (m.status !== 'recording') continue;
        if (active && active.id === m.id) continue;
        const chunks = await store.chunks(m.id);
        if (!chunks.length) { await store.remove(m.id); changed = true; continue; }
        m.status = 'done';
        m.recovered = true;
        await store.putMeta(m);
        changed = true;
    }
    if (changed) emitChange();
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
