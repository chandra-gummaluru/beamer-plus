// iframe-widget-renderer.js
// Renders widgets from HTML files in the zip file.
//
import { widgetSessionConfig } from '../app/session.js';

// ── Persistence strategy ───────────────────────────────────────────────────
// Iframes are NEVER moved or destroyed during normal slide navigation.
// When a slide is "parked" (navigated away from) its iframes stay in the
// same container but are hidden via opacity:0 + pointer-events:none.
// When the slide is revisited they are revealed and the widget is told to
// re-render (resize event + widget-set-state) so canvas content is restored.
// This guarantees the iframe never reloads and all JS state is preserved.

// ── Shared widget base theme ───────────────────────────────────────────────
// Injected into every widget iframe before its own <style>, so all widgets
// share one design language — tokens, reset, toolbars, buttons, status pills,
// inputs, banners. See static/css/widget-base.css. A widget's own rules come
// later in the document and still win, so overriding remains possible.

const _WIDGET_BASE_INJECT = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;1,400&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/css/widget-base.css">
<script id="widget-nav-bridge">
(function () {
  // Forwards ArrowLeft/ArrowRight/PageUp/PageDown to the parent frame so the
  // presentation can advance slides even when a widget iframe has focus.
  // Native DOM events don't bubble across an iframe boundary, so this can't
  // be done by the parent's own document-level keydown listener — each
  // widget has to opt back out itself.
  //
  // A widget that wants to own these keys for its own purposes (paging,
  // seeking, etc.) just needs to call e.preventDefault() in its own keydown
  // handler; we check e.defaultPrevented (via a deferred callback, so it
  // doesn't matter whether the widget's handler was registered before or
  // after this one) and skip forwarding if so.
  var NAV_KEYS = { ArrowLeft: 1, ArrowRight: 1, PageUp: 1, PageDown: 1 };

  function isEditable(el) {
    if (!el) return false;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  document.addEventListener('keydown', function (e) {
    if (!NAV_KEYS[e.key]) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Defer: let any other keydown listener on this event (regardless of
    // registration order) run first and call preventDefault() if it wants
    // to handle the key itself.
    setTimeout(function () {
      if (e.defaultPrevented) return;
      if (isEditable(document.activeElement)) return;
      try { parent.postMessage({ type: 'widget-nav', key: e.key, repeat: !!e.repeat }, '*'); } catch (_) {}
    }, 0);
  });
})();
</script>`;

// Loaded after window.WIDGET_CONFIG so it can read the widget's own id on its
// first tick. srcdoc iframes inherit the parent's origin, so this resolves and
// caches like any other same-origin script.
const _SETTINGS_KIT_INJECT = `<script src="/static/js/widget-settings-kit.js"></script>`;

// ── Widget schema protocol ─────────────────────────────────────────────────
// Each widget HTML file may declare its own editable fields via:
//
//   <script id="widget-schema" type="application/json">
//   { "label": "...", "category": "...", "fields": [ ... ] }
//   </script>
//
// The settings kit injected into every widget reads this and renders the
// widget's own settings panel from it — Beamer+ itself never renders these
// fields, and the editor panel shows only the widget's geometry. A widget that
// wants a settings UI of its own declares "customSettings": true and handles
// the widget-open-settings message itself.
// The fields array:
//   { key, label, type, placeholder?, default?, min?, max?, step?, note?,
//     options?: [{v, l}], rows? }
// type ∈ text | number | number-nullable | checkbox | select | textarea | textarea-lines

// ── Expand/collapse registry ───────────────────────────────────────────────
// widgetId → { iframe, container, savedStyle }
const _widgetRegistry = new Map();
let _expandListenerAttached = false;

function _ensureExpandListener() {
    if (_expandListenerAttached) return;
    _expandListenerAttached = true;
    window.addEventListener('message', e => {
        if (isPrintWindow(e.source)) return;   // a print copy speaks for no live iframe
        const { type } = e.data || {};
        // The registry is keyed by the string form of the id (dataset values are
        // always strings); a deck whose JSON carries numeric ids would otherwise
        // miss every lookup here.
        const widgetId = String(e.data?.widgetId ?? '');
        if (type === 'widget-expand') {
            const entry = _widgetRegistry.get(widgetId);
            if (!entry) return;
            const { iframe, container } = entry;
            const rect = container.getBoundingClientRect();
            entry.savedStyle = {
                left:       iframe.style.left,
                top:        iframe.style.top,
                width:      iframe.style.width,
                height:     iframe.style.height,
                zIndex:     iframe.style.zIndex,
                transition: iframe.style.transition,
            };
            iframe.style.transition = 'left 0.45s ease, top 0.45s ease, width 0.45s ease, height 0.45s ease';
            iframe.style.left   = '0px';
            iframe.style.top    = '0px';
            iframe.style.width  = rect.width  + 'px';
            iframe.style.height = rect.height + 'px';
            iframe.style.zIndex = '500';
        } else if (type === 'widget-collapse') {
            const entry = _widgetRegistry.get(widgetId);
            if (!entry?.savedStyle) return;
            Object.assign(entry.iframe.style, entry.savedStyle);
            entry.savedStyle = null;
        }
    });
}

// ── Captured states ────────────────────────────────────────────────────────
// Populated by widget-get-state sent when parking, used to re-trigger
// widget rendering (e.g. canvas redraws) when the slide is revisited.
const _capturedStates = new Map(); // String(widgetId) → state

window.addEventListener('message', e => {
    // A print copy (see printWidget) shares the live widget's id; what it
    // reports must never stand in for the live widget's state.
    if (isPrintWindow(e.source)) return;
    if (e.data?.type === 'widget-state' && e.data.widgetId != null && e.data.state !== undefined) {
        _capturedStates.set(String(e.data.widgetId), e.data.state);
    }
});

// States loaded from ZIP to restore into freshly-created iframes
let _savedWidgetStates = {};

// ── One widget, two iframes ────────────────────────────────────────────────
// A slide's widgets get their own iframes per pane (L:<slide> and R:<slide>),
// so a slide that has been both full-screen and in a split view has two live
// copies of each widget. Only one of them is ever on screen; whichever was
// shown last holds the real state. When the other copy is shown, it takes
// that state over first — otherwise a change made in the split view's copy
// vanished on returning to the slide (and vice versa), and a save could
// pick up the stale copy.
const _lastShown = new Map();   // String(widgetId) → the iframe last on screen

function _markShown(widgetId, iframe) {
    _lastShown.set(String(widgetId), iframe);
}

// The copy that holds a widget's current state, if it is still in the page.
function _authority(widgetId) {
    const f = _lastShown.get(String(widgetId));
    if (f && f.isConnected) return f;
    _lastShown.delete(String(widgetId));
    return null;
}

// One iframe per widget id — the authoritative copy where there are two.
function _iframesById(filter = null) {
    const out = new Map();
    document.querySelectorAll('.widget-iframe').forEach(f => {
        const wid = f.dataset.widgetId;
        if (!wid || (filter && !filter.has(wid))) return;
        const auth = _authority(wid);
        if (auth) out.set(wid, auth);
        else if (!out.has(wid)) out.set(wid, f);
    });
    return out;
}

// Ask one iframe for its state. Resolves undefined if it doesn't answer.
function _askState(iframe, timeoutMs = 700) {
    const win = iframe?.contentWindow;
    if (!win) return Promise.resolve(undefined);
    return new Promise(resolve => {
        const done = (v) => { clearTimeout(timer); window.removeEventListener('message', onMsg); resolve(v); };
        const timer = setTimeout(() => done(undefined), timeoutMs);
        function onMsg(e) {
            if (e.source !== win || e.data?.type !== 'widget-state' || e.data.state === undefined) return;
            done(e.data.state);
        }
        window.addEventListener('message', onMsg);
        try { win.postMessage({ type: 'widget-get-state' }, '*'); } catch (_) { done(undefined); }
    });
}

// The state to hand a copy of `widgetId` that is about to be shown, taken
// from the other copy if that one was on screen more recently. undefined
// when there is nothing newer than what `target` already has — or when the
// other copy runs older settings (the widget was edited since), whose state
// a rebuilt widget doesn't take over.
function _stateFromOtherCopy(widgetId, target, sig) {
    const auth = _authority(widgetId);
    if (!auth || auth === target || auth.dataset.widgetSig !== sig) return Promise.resolve(undefined);
    return _askState(auth);
}

/**
 * Store widget states to be injected after each widget iframe first loads.
 * Called when a ZIP is loaded that contains config/widget-states.json.
 */
export function setWidgetStates(states) {
    _savedWidgetStates = (states && typeof states === 'object') ? states : {};
}

/**
 * The widget states that came in with the deck. Saving needs them for every
 * widget that hasn't been opened this session: those have no iframe to ask,
 * and would otherwise silently lose their saved state on the next save.
 */
export function getLoadedWidgetStates() {
    return { ..._savedWidgetStates };
}

/**
 * Add states for widgets that haven't been created yet (a duplicated slide's
 * fresh widget ids); each is handed to its iframe when that first loads.
 */
export function seedWidgetStates(states) {
    if (!states || typeof states !== 'object') return;
    Object.assign(_savedWidgetStates, states);
}

/**
 * The current state of each widget in `ids`: asked live from its iframe if it
 * has one, else the last state captured when it was parked, else the state it
 * was loaded with. Widgets that report nothing are simply absent.
 */
export function requestWidgetStates(ids, timeoutMs = 800) {
    const want = new Set((ids || []).map(String));
    const states = {};
    for (const id of want) {
        if (_capturedStates.has(id)) states[id] = _capturedStates.get(id);
        else if (_savedWidgetStates[id] !== undefined) states[id] = _savedWidgetStates[id];
    }
    const iframes = Array.from(_iframesById(want).values());
    if (!iframes.length) return Promise.resolve(states);
    const pending = new Set(iframes.map(f => f.dataset.widgetId));
    return new Promise(resolve => {
        const done = () => { clearTimeout(timer); window.removeEventListener('message', onMsg); resolve(states); };
        const timer = setTimeout(done, timeoutMs);
        function onMsg(e) {
            if (isPrintWindow(e.source)) return;
            if (!iframes.some(f => f.contentWindow === e.source)) return;   // not the copy we asked
            const id = e.data?.widgetId != null ? String(e.data.widgetId) : null;
            if (e.data?.type !== 'widget-state' || !id || !pending.has(id) || e.data.state === undefined) return;
            states[id] = e.data.state;
            pending.delete(id);
            if (!pending.size) done();
        }
        window.addEventListener('message', onMsg);
        iframes.forEach(f => { try { f.contentWindow?.postMessage({ type: 'widget-get-state' }, '*'); } catch (_) {} });
    });
}

// ── CSS selector helper ────────────────────────────────────────────────────
// slideKey values are "L0", "R0", etc. – safe for attribute selectors.
function _bySlideSel(slideKey) {
    return `.widget-iframe[data-widget-slide="${slideKey}"]`;
}

// Escape text before dropping it into an iframe srcdoc. srcdoc iframes inherit
// the parent's origin, so an unescaped widget path or error message could run
// script as same-origin. Used only for the error placeholders below.
function _escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// ── Park / restore ─────────────────────────────────────────────────────────

/**
 * "Park" the current slide's widgets: hide them with opacity:0 and ask each
 * one to report its state (so we can re-render canvases on reveal).
 * Iframes remain in the container — they are NOT moved or reloaded.
 */
export function parkWidgets(container, slideKey) {
    const iframes = Array.from(container.querySelectorAll(_bySlideSel(slideKey)));
    if (iframes.length === 0) return;

    iframes.forEach(iframe => {
        iframe.style.opacity       = '0';
        iframe.style.pointerEvents = 'none';
        iframe.style.zIndex        = '-1';  // ensure hidden behind visible iframes
        const wid = iframe.dataset.widgetId;
        if (wid) {
            _widgetRegistry.delete(wid);
            // Capture state now; will be re-applied when the slide is revisited.
            try { iframe.contentWindow?.postMessage({ type: 'widget-get-state' }, '*'); } catch (_) {}
        }
    });
}

/**
 * Destroy the widget iframes belonging to a specific slide, except those whose
 * id is in `keepIds` (when given).
 */
export function discardParkedWidgets(slideKey, keepIds = null) {
    document.querySelectorAll(_bySlideSel(slideKey)).forEach(iframe => {
        const wid = iframe.dataset.widgetId;
        if (keepIds && keepIds.has(String(wid))) return;
        if (wid) { _widgetRegistry.delete(wid); _capturedStates.delete(String(wid)); }
        try { iframe.contentWindow?.postMessage({ type: 'widget-cleanup' }, '*'); } catch (_) {}
        iframe.remove();
    });
}

/**
 * Destroy ALL widget iframes in the document and reset saved states.
 * Call when a new presentation is loaded.
 */
export function clearAllParked() {
    document.querySelectorAll('.widget-iframe').forEach(iframe => {
        const wid = iframe.dataset.widgetId;
        if (wid) _widgetRegistry.delete(wid);
        try { iframe.contentWindow?.postMessage({ type: 'widget-cleanup' }, '*'); } catch (_) {}
        iframe.remove();
    });
    _capturedStates.clear();
    _lastShown.clear();
    _savedWidgetStates = {};
    _revokePendingAssetUrls();   // a new deck's files are its own
}

/**
 * Collect serialised state from ALL live iframes (visible + hidden).
 * Sends { type:'widget-get-state' } to each iframe and waits for
 * { type:'widget-state', widgetId, state } replies.
 * Resolves with a { widgetId: state } map after timeoutMs.
 */
export async function collectWidgetStates(timeoutMs = 1500) {
    const allIframes = _iframesById();

    if (allIframes.size === 0) return {};

    const states = {};
    const pending = new Set(allIframes.keys());

    return new Promise(resolve => {
        const done = () => {
            clearTimeout(timer);
            window.removeEventListener('message', handler);
            resolve(states);
        };
        const timer = setTimeout(done, timeoutMs);

        function handler(e) {
            if (isPrintWindow(e.source)) return;
            if (e.data?.type === 'widget-state' && e.data.widgetId && e.data.state !== undefined) {
                // Only the copy we asked: the other pane's copy of the same
                // widget may be stale.
                if (allIframes.get(String(e.data.widgetId))?.contentWindow !== e.source) return;
                states[e.data.widgetId] = e.data.state;
                pending.delete(e.data.widgetId);
                if (pending.size === 0) done();
            }
        }
        window.addEventListener('message', handler);

        allIframes.forEach(iframe => {
            try { iframe.contentWindow?.postMessage({ type: 'widget-get-state' }, '*'); } catch (_) {}
        });
    });
}

// ── Files added this session ───────────────────────────────────────────────
// A file the presenter uploads in the editor lives in two places until the deck
// is saved: in the browser (state.editorNewFiles) and, if the POST got through,
// in the server's per-session memory. Widgets ask for it by path, which the
// server resolves — so anything that stops the upload (a proxy capping request
// bodies, a server running more than one worker process) leaves the widget
// asking for a file the server has never seen.
//
// The browser already holds the bytes, so hand the widget a blob URL for them
// instead. That needs no upload, no server round trip and no shared state
// between processes, which is why it works on a real deployment and not only on
// localhost. Once the deck is saved the file is in the ZIP and resolves the
// normal way.
const _pendingAssetUrls = new Map();   // deck-relative path → blob: URL

// Layout keys belong to Beamer+ and are never file paths — `src` in particular
// already carries a blob URL for a custom widget's own HTML.
const _NOT_ASSET_KEYS = new Set([
    'id', 'type', 'x', 'y', 'width', 'height', 'zIndex',
    'builtin', 'src', 'interactive', 'role',
    'sessionId', 'socketUrl', 'serverUrl', 'publicBaseUrl',
]);

// ── Config signature ───────────────────────────────────────────────────────
// A parked iframe is reused only while its widget's settings are the ones it
// was built with. Layout keys are left out: moving or resizing a widget is
// applied in place, and must not reboot it (a notebook would reload its
// kernel, a shell would lose its session).
const _LAYOUT_KEYS = new Set(['x', 'y', 'width', 'height', 'zIndex', 'interactive', 'step']);

// A widget whose schema declares "fullSlide": true only works as the whole
// slide; it is always laid out that way, whatever box an older deck saved.
const _FULL_GEOM = { x: 0, y: 0, width: 1, height: 1 };
function _declaresFullSlide(html) {
    const m = /<script\b[^>]*\bid=["']widget-schema["'][^>]*>([\s\S]*?)<\/script>/i.exec(html || '');
    if (!m) return false;
    try { return JSON.parse(m[1].trim())?.fullSlide === true; } catch (_) { return false; }
}
function _geom(w, iframe) {
    return iframe?.dataset.widgetFull === 'true' ? _FULL_GEOM
         : { x: w.x, y: w.y, width: w.width, height: w.height };
}
function _place(iframe, g, rect) {
    Object.assign(iframe.dataset, { widgetX: g.x, widgetY: g.y, widgetWidth: g.width, widgetHeight: g.height });
    iframe.style.left   = `${g.x * rect.width}px`;
    iframe.style.top    = `${g.y * rect.height}px`;
    iframe.style.width  = `${g.width * rect.width}px`;
    iframe.style.height = `${g.height * rect.height}px`;
}

function _configSignature(w) {
    const out = {};
    for (const key of Object.keys(w || {}).sort()) {
        if (!_LAYOUT_KEYS.has(key)) out[key] = w[key];
    }
    try { return JSON.stringify(out); } catch (_) { return String(Math.random()); }
}

/**
 * Record that a widget's live iframe already reflects its current config item.
 * Called when the widget itself wrote to the item (a saved file path, a
 * setting changed from inside the widget) — the iframe made that change, so
 * it must not be rebuilt for it.
 */
export function syncWidgetSignature(widgetId, item) {
    document.querySelectorAll(`.widget-iframe[data-widget-id="${CSS.escape(String(widgetId))}"]`)
        .forEach(iframe => { iframe.dataset.widgetSig = _configSignature(item); });
}

function _pendingAssetUrl(path) {
    const buffer = window.beamerState?.editorNewFiles?.[path];
    if (!buffer) return null;
    if (!_pendingAssetUrls.has(path)) {
        _pendingAssetUrls.set(path, URL.createObjectURL(new Blob([buffer])));
    }
    return _pendingAssetUrls.get(path);
}

function _withPendingAssets(payload) {
    const out = { ...payload };
    for (const [key, value] of Object.entries(out)) {
        if (typeof value !== 'string' || _NOT_ASSET_KEYS.has(key)) continue;
        const url = _pendingAssetUrl(value);
        if (url) out[key] = url;
    }
    return out;
}

function _revokePendingAssetUrls() {
    for (const url of _pendingAssetUrls.values()) {
        try { URL.revokeObjectURL(url); } catch (_) {}
    }
    _pendingAssetUrls.clear();
}

// ── Main render function ───────────────────────────────────────────────────

/**
 * @param {object}  slideConfig  - slide config object with .widgets array
 * @param {Element} container    - DOM container to place iframes in
 * @param {object}  zipFile      - JSZip instance (may be null for built-ins)
 * @param {boolean} viewerMode
 * @param {string|null} slideKey - unique key for this slide+pane combo
 */
export function renderWidgets(slideConfig, container, zipFile, viewerMode = false, slideKey = null) {
    if (!slideConfig.widgets || slideConfig.widgets.length === 0) {
        return Promise.resolve();
    }

    // Find any already-hidden iframes for this slide still in the container.
    const existingMap = new Map();
    if (slideKey != null) {
        container.querySelectorAll(_bySlideSel(slideKey)).forEach(iframe => {
            existingMap.set(iframe.dataset.widgetId, iframe);
        });
    }

    const promises = slideConfig.widgets.map(async (w) => {
        // dataset properties are always strings; w.id may be a number from JSON —
        // coerce to string so the Map lookup matches the string keys in existingMap.
        let existing = existingMap.get(String(w.id));

        // Settings changed since this iframe was built (edited in the editor):
        // it has to be rebuilt to pick them up. Anything else — including a
        // plain trip in and out of edit mode — keeps the live iframe.
        if (existing && existing.dataset.widgetSig !== _configSignature(w)) {
            existingMap.delete(String(w.id));
            _capturedStates.delete(String(w.id));
            try { existing.contentWindow?.postMessage({ type: 'widget-cleanup' }, '*'); } catch (_) {}
            existing.remove();
            existing = null;
        }

        if (existing) {
            // ── Reveal parked iframe ───────────────────────────────────────
            existingMap.delete(String(w.id));
            // The other pane's copy may have moved on since this one was
            // parked; ask it before this copy becomes the one on screen.
            const fromOther = _stateFromOtherCopy(w.id, existing, existing.dataset.widgetSig);
            _markShown(w.id, existing);

            // Always key the registry by the string form of the id: parkWidgets
            // and the expand/collapse listener look it up via the iframe's
            // dataset.widgetId, which is always a string. Mixing a numeric w.id
            // key here would leave stale entries that never get cleaned up.
            _widgetRegistry.set(String(w.id), { iframe: existing, container, savedStyle: null });
            _ensureExpandListener();

            // Restore position / size — the container may have been resized, or
            // the widget moved in the editor. The dataset is what later
            // resizes read, so it has to follow too.
            Object.assign(existing.dataset, {
                widgetZIndex: w.zIndex || 10,
                widgetInteractive: w.interactive !== false ? 'true' : 'false',
            });
            const rect = container.getBoundingClientRect();
            const g = _geom(w, existing);
            _place(existing, g, rect);
            // The box may have changed between full slide and part of it —
            // the widget shows its top bar only when it fills the slide.
            try { existing.contentWindow?.postMessage({ type: 'widget-layout', ...g }, '*'); } catch (_) {}
            existing.style.zIndex        = w.zIndex || 10;
            existing.style.pointerEvents = w.interactive !== false ? 'auto' : 'none';
            existing.style.opacity       = '1';  // make visible

            // After a short delay (browser reflow), fire resize and re-apply
            // captured state so canvas-based widgets redraw correctly.
            const widId = String(w.id);
            const newer = await fromOther;
            if (newer !== undefined) _capturedStates.set(widId, newer);
            setTimeout(() => {
                try { existing.contentWindow?.dispatchEvent(new Event('resize')); } catch (_) {}
                // Its own state from when it was parked, or the other copy's
                // if that one was shown since.
                const captured = newer !== undefined ? newer : _capturedStates.get(widId);
                if (captured !== undefined) {
                    try {
                        existing.contentWindow?.postMessage({ type: 'widget-set-state', state: captured }, '*');
                    } catch (_) {}
                }
            }, 50);

            return;
        }

        // ── Create new iframe ──────────────────────────────────────────────
        const iframe = document.createElement('iframe');
        iframe.className = 'widget-iframe';
        iframe.dataset.widgetId    = w.id;
        iframe.dataset.widgetSlide = slideKey ?? '';   // which slide owns this iframe
        iframe.dataset.widgetSig   = _configSignature(w);

        iframe.dataset.widgetX      = w.x;
        iframe.dataset.widgetY      = w.y;
        iframe.dataset.widgetWidth  = w.width;
        iframe.dataset.widgetHeight = w.height;
        iframe.dataset.widgetZIndex = w.zIndex || 10;
        iframe.dataset.widgetInteractive = w.interactive !== false ? 'true' : 'false';

        const rect = container.getBoundingClientRect();
        iframe.style.position      = 'absolute';
        iframe.style.left          = `${w.x * rect.width}px`;
        iframe.style.top           = `${w.y * rect.height}px`;
        iframe.style.width         = `${w.width * rect.width}px`;
        iframe.style.height        = `${w.height * rect.height}px`;
        iframe.style.zIndex        = w.zIndex || 10;
        iframe.style.border        = 'none';
        iframe.style.background    = 'transparent';
        iframe.style.pointerEvents = w.interactive !== false ? 'auto' : 'none';
        iframe.style.opacity       = '1';

        iframe.allow = 'autoplay; fullscreen; camera; microphone';

        // A copy of this widget may already be running in the other pane
        // (the slide was shown there first): start from its state, not the
        // one the deck was loaded with.
        const fromOther = _stateFromOtherCopy(w.id, iframe, iframe.dataset.widgetSig);
        container.appendChild(iframe);
        _markShown(w.id, iframe);
        _widgetRegistry.set(String(w.id), { iframe, container, savedStyle: null });
        _ensureExpandListener();

        try {
            const loaded = await _loadWidgetSource(w, zipFile);
            if (loaded.missing) {
                console.error(`Widget file not found in zip: ${loaded.missing}`);
                iframe.srcdoc = `<div style="padding:20px;font-family:sans-serif;color:#666;">Widget not found: ${_escapeHtml(loaded.missing)}</div>`;
                return;
            }
            const { htmlContent, notebookContent } = loaded;

            // Pin full-slide-only widgets to the whole slide (older decks may
            // have saved a smaller box for them).
            const fullOnly = _declaresFullSlide(htmlContent);
            if (fullOnly) {
                iframe.dataset.widgetFull = 'true';
                _place(iframe, _FULL_GEOM, container.getBoundingClientRect());
            }

            const _configPayload = _withPendingAssets({
                ...w,
                ...(fullOnly ? _FULL_GEOM : {}),
                ...widgetSessionConfig(),
                role: viewerMode ? 'viewer' : 'presenter',
                ...(notebookContent !== null ? { notebookContent } : {}),
            });
            const _injectedHtml = _buildSrcdoc(htmlContent, _configPayload);

            await new Promise(resolve => {
                let settled = false;
                const finish = () => { if (!settled) { settled = true; resolve(); } };
                iframe.addEventListener('load', async () => {
                    iframe.contentWindow.postMessage({ type: 'widget-config', config: _configPayload }, '*');
                    const newer = await fromOther;
                    const savedState = newer !== undefined ? newer : _savedWidgetStates[w.id];
                    if (savedState !== undefined) {
                        iframe.contentWindow?.postMessage({ type: 'widget-set-state', state: savedState }, '*');
                    }
                    finish();
                }, { once: true });
                setTimeout(finish, 6000);
                iframe.srcdoc = _injectedHtml;
            });

        } catch (error) {
            console.error('Error loading widget:', error);
            iframe.srcdoc = `<div style="padding:20px;font-family:sans-serif;color:#e74c3c;">Error loading widget: ${_escapeHtml(error.message)}</div>`;
        }
    });

    // Destroy any hidden iframes whose widget ID is no longer in the config
    // (the widget was removed from the slide while it was not being viewed).
    existingMap.forEach((iframe, wid) => {
        _widgetRegistry.delete(wid);
        _capturedStates.delete(String(wid));
        try { iframe.contentWindow?.postMessage({ type: 'widget-cleanup' }, '*'); } catch (_) {}
        iframe.remove();
    });

    return Promise.all(promises);
}

// ── Widget source ──────────────────────────────────────────────────────────

/**
 * Fetch a widget's HTML (built-in, custom blob, or from the deck) plus its
 * pre-loaded notebook, if it names one. Resolves `{ missing: path }` when a
 * deck widget's file isn't in the ZIP; throws on any other failure.
 */
async function _loadWidgetSource(w, zipFile) {
    let htmlContent;

    if (w.builtin) {
        const res = await fetch(`/widgets/${encodeURIComponent(w.type)}.html`);
        if (!res.ok) throw new Error(`Built-in widget not found: ${w.type} (${res.status})`);
        htmlContent = await res.text();
    } else if (w.src && /^blob:/i.test(w.src)) {
        // Blob URLs are ephemeral — they only resolve within the page
        // load that created them (via URL.createObjectURL). A deck saved
        // with a blob src (or simply reloaded) carries a dead URL, so on
        // failure fall back to the widget's HTML stored in the ZIP.
        try {
            const res = await fetch(w.src);
            if (!res.ok) throw new Error('Could not load custom widget blob');
            htmlContent = await res.text();
        } catch (blobErr) {
            const fallbackPath = resolveWidgetPath(w);
            const fallbackFile = findWidgetFile(zipFile, fallbackPath);
            if (!fallbackFile) throw blobErr;
            htmlContent = await fallbackFile.async('string');
        }
    } else {
        const widgetPath = resolveWidgetPath(w);
        const widgetFile = findWidgetFile(zipFile, widgetPath);
        if (!widgetFile) return { missing: widgetPath };
        htmlContent = await widgetFile.async('string');
    }

    // Pre-load notebook from zip if widget config specifies a local path.
    // Remote URLs (http/https) are passed through as-is and fetched by the
    // widget itself, so we skip the ZIP lookup for those.
    let notebookContent = null;
    if (w.notebook && typeof w.notebook === 'string' && w.notebook.trim()) {
        const nb = w.notebook.trim();
        if (!/^https?:\/\//i.test(nb)) {
            const nbPath = nb.replace(/^\/+/, '');
            const nbFile = zipFile?.file(nbPath)
                || zipFile?.filter((p, f) => !f.dir && p.toLowerCase() === nbPath.toLowerCase())[0];
            if (nbFile) {
                try { notebookContent = JSON.parse(await nbFile.async('string')); }
                catch (e) { console.warn(`Failed to parse notebook ${nbPath}:`, e); }
            } else {
                console.warn(`Notebook file not found in zip: ${nbPath}`);
            }
        }
    }
    return { htmlContent, notebookContent };
}

// Inject shared base theme + widget config + settings kit right after <head>.
// _WIDGET_BASE_INJECT comes first so each widget's own <style> wins over
// defaults; the kit comes last because it reads window.WIDGET_CONFIG.
// `prelude` goes ahead of all of it (the print copy's socket stub).
function _buildSrcdoc(htmlContent, configPayload, prelude = '') {
    const configJson   = JSON.stringify(configPayload).replace(/<\/script>/gi, '<\\/script>');
    const configScript = `<script>window.WIDGET_CONFIG=${configJson};<\/script>`;
    return htmlContent.replace(
        /(<head[^>]*>)/i,
        // A function, not a string: a widget's HTML or config can contain
        // `$&` / `$1`, which String.replace would otherwise expand.
        (head) => `${head}${prelude}${_WIDGET_BASE_INJECT}${configScript}${_SETTINGS_KIT_INJECT}`
    );
}

/** The schema block a widget declares, or null. */
function _readSchema(html) {
    const m = /<script\b[^>]*\bid=["']widget-schema["'][^>]*>([\s\S]*?)<\/script>/i.exec(html || '');
    if (!m) return null;
    try { return JSON.parse(m[1].trim()); } catch (_) { return null; }
}

// ── Printing (notes PDF) ───────────────────────────────────────────────────
// A widget is printed from a throwaway copy, never from the live iframe: the
// copy can be sized to the page and its state set without anything moving on
// stage or reaching the room. It runs as a viewer, with printMode set, and
// with socket.io stubbed out before any widget script runs — a print copy
// must never broadcast (a fresh presenter copy would push its starting state
// to every phone) or open polls.
//
// Protocol, host → widget:  { type: 'widget-print', requestId, scale }
//           widget → host:  { type: 'widget-print-result', requestId, ok, image?, pages?, reason? }
// The settings kit (injected into every widget) answers on the widget's
// behalf: ok:false / 'unsupported' unless the widget registered a handler
// with BeamerWidget.print.register(). See bpwidget-skill.md.

const _PRINT_PRELUDE = `<script id="bw-print-sandbox">
(function () {
  function noop() { return sock; }
  var sock = { connected: false, id: null, on: noop, once: noop, off: noop, emit: noop,
               connect: noop, disconnect: noop, close: noop, removeAllListeners: noop,
               io: { on: noop, off: noop } };
  function io() { return sock; }
  io.connect = io; io.Manager = function () {}; io.Socket = function () {};
  try { Object.defineProperty(window, 'io', { get: function () { return io; }, set: function () {}, configurable: false }); }
  catch (_) { window.io = io; }
  window.BEAMER_PRINT = true;
  // Paper shows the end state. Widgets animate into it — bars growing,
  // numbers counting up, new items fading in — and a snapshot taken a frame
  // or two after a render caught them part-way (short bars, low counts,
  // half-transparent answers). So: report reduced motion to scripts that ask,
  // and switch CSS transitions and animations off (the style below).
  try {
    var mm = window.matchMedia && window.matchMedia.bind(window);
    if (mm) window.matchMedia = function (q) {
      var r = mm(q);
      if (String(q).replace(/ /g, '').toLowerCase().indexOf('prefers-reduced-motion:reduce') < 0) return r;
      return { matches: true, media: r.media, onchange: null,
               addListener: function () {}, removeListener: function () {},
               addEventListener: function () {}, removeEventListener: function () {},
               dispatchEvent: function () { return false; } };
    };
  } catch (_) {}
})();
<\/script>
<style id="bw-print-still">
*, *::before, *::after {
  transition: none !important;
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  scroll-behavior: auto !important;
}
</style>`;

// Windows of print copies — their messages must not be taken for the live
// widget's (they share its widget id).
const _printWindows = new WeakSet();
export function isPrintWindow(win) { return !!win && _printWindows.has(win); }

/**
 * Print one widget. Resolves to
 *   { ok: true,  image?, pages?, label }   — the widget answered
 *   { ok: false, reason, label }           — unsupported, failed or timed out
 * `box` is the widget's size in CSS px; `state` is the state to show.
 */
export async function printWidget(w, { zipFile, box, fullBox = null, state, scale = 2, host = document.body,
                                       loadTimeoutMs = 30000, printTimeoutMs = 45000 } = {}) {
    let label = w?.type || 'Widget';
    let loaded;
    try { loaded = await _loadWidgetSource(w, zipFile); }
    catch (err) { return { ok: false, reason: err.message, label }; }
    if (loaded.missing) return { ok: false, reason: 'widget file not found', label };
    const schema = _readSchema(loaded.htmlContent);
    label = (typeof w.title === 'string' && w.title.trim()) || schema?.label || label;

    // A full-slide-only widget is laid out over the whole slide, whatever
    // box an older deck saved for it — on paper as on stage.
    const fullOnly = schema?.fullSlide === true;
    if (fullOnly && fullBox) box = fullBox;
    const tag = (res) => ({ ...res, label, fullSlide: fullOnly });
    const payload = _withPendingAssets({
        ...w,
        ...(fullOnly ? _FULL_GEOM : {}),
        ...widgetSessionConfig(),
        role: 'viewer',
        printMode: true,
        autoStart: false,
        ...(loaded.notebookContent !== null ? { notebookContent: loaded.notebookContent } : {}),
    });

    const iframe = document.createElement('iframe');
    iframe.className = 'widget-print-iframe';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    // In the viewport and laid out at full size (so layout, canvases and
    // html2canvas see real dimensions), but invisible and inert. Parked live
    // widgets are hidden the same way and keep running.
    Object.assign(iframe.style, {
        position: 'fixed', left: '0px', top: '0px',
        width: `${Math.max(40, Math.round(box.width))}px`,
        height: `${Math.max(30, Math.round(box.height))}px`,
        border: 'none', opacity: '0', pointerEvents: 'none', zIndex: '-1',
        background: 'transparent',
    });
    host.appendChild(iframe);

    const requestId = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    try {
        // The load event waits for every script and stylesheet, CDN ones
        // included; on a slow network that can take a while. The kit inside
        // waits for the same things before it answers, so a timeout here only
        // means "ask anyway".
        await new Promise(resolve => {
            const t = setTimeout(resolve, loadTimeoutMs);
            iframe.addEventListener('load', () => { clearTimeout(t); resolve(); }, { once: true });
            iframe.srcdoc = _buildSrcdoc(loaded.htmlContent, payload, _PRINT_PRELUDE);
        });
        const win = iframe.contentWindow;
        if (!win) return tag({ ok: false, reason: 'widget did not load' });
        _printWindows.add(win);

        // The state travels with the request; the kit applies it once the
        // widget is ready to receive it (see handlePrint in the kit).
        return await new Promise(resolve => {
            let acked = false, resend = null, timer = null;
            const done = (res) => {
                clearTimeout(timer); clearInterval(resend);
                window.removeEventListener('message', onMsg);
                resolve(tag(res));
            };
            const ask = () => {
                try { win.postMessage({ type: 'widget-print', requestId, scale, state }, '*'); }
                catch (err) { done({ ok: false, reason: err.message }); }
            };
            function onMsg(e) {
                if (e.source !== win) return;
                const d = e.data || {};
                if (d.requestId !== requestId) return;
                if (d.type === 'widget-print-ack' && !acked) {
                    // Heard: stop re-asking, and give it its full time from now
                    // (it may still be waiting on the network).
                    acked = true;
                    clearInterval(resend);
                    clearTimeout(timer);
                    timer = setTimeout(() => done({ ok: false, reason: 'timed out' }), printTimeoutMs);
                }
                if (d.type !== 'widget-print-result') return;
                if (d.ok) done({ ok: true, image: d.image || null, pages: Array.isArray(d.pages) ? d.pages : [] });
                else      done({ ok: false, reason: d.reason || 'unsupported' });
            }
            window.addEventListener('message', onMsg);
            // The kit's listener may not exist yet if the document is still
            // parsing; ask again until it says it heard.
            timer  = setTimeout(() => done({ ok: false, reason: 'no answer' }), loadTimeoutMs);
            resend = setInterval(ask, 1000);
            ask();
        });
    } catch (err) {
        return tag({ ok: false, reason: err.message });
    } finally {
        try { iframe.contentWindow?.postMessage({ type: 'widget-cleanup' }, '*'); } catch (_) {}
        // Give cleanup a tick to run before the document goes away.
        setTimeout(() => iframe.remove(), 50);
    }
}

// ── Talking to one widget ──────────────────────────────────────────────────

export function findWidgetIframe(widgetId) {
    return document.querySelector(`.widget-iframe[data-widget-id="${CSS.escape(String(widgetId))}"]`);
}

/** Post a message to one widget. Returns false if that widget isn't live. */
export function postToWidget(widgetId, message) {
    const iframe = findWidgetIframe(widgetId);
    if (!iframe?.contentWindow) return false;
    try { iframe.contentWindow.postMessage(message, '*'); return true; }
    catch (_) { return false; }
}

/**
 * Identify the widget a postMessage came from. Messages that write to the
 * presentation are only honoured when the sending window really is the widget
 * iframe it claims to speak for.
 */
export function widgetIdForWindow(win) {
    if (!win) return null;
    for (const iframe of document.querySelectorAll('.widget-iframe')) {
        if (iframe.contentWindow === win) return iframe.dataset.widgetId ?? null;
    }
    return null;
}

// ── Position update ────────────────────────────────────────────────────────

export function updateWidgetPositions(container) {
    const rect = container.getBoundingClientRect();
    container.querySelectorAll('.widget-iframe').forEach(iframe => {
        const x      = parseFloat(iframe.dataset.widgetX);
        const y      = parseFloat(iframe.dataset.widgetY);
        const width  = parseFloat(iframe.dataset.widgetWidth);
        const height = parseFloat(iframe.dataset.widgetHeight);
        if (!isNaN(x) && !isNaN(y) && !isNaN(width) && !isNaN(height)) {
            iframe.style.left   = `${x * rect.width}px`;
            iframe.style.top    = `${y * rect.height}px`;
            iframe.style.width  = `${width * rect.width}px`;
            iframe.style.height = `${height * rect.height}px`;
        }
    });
}

// ── Path resolution helpers ────────────────────────────────────────────────

export function resolveWidgetPath(widget) {
    const candidates = [
        widget?.path, widget?.src, widget?.file, widget?.url,
        widget?.type ? `widgets/${widget.type}.html` : null,
        widget?.id   ? `widgets/${widget.id}.html`   : null,
    ];
    for (const raw of candidates) {
        if (!raw || typeof raw !== 'string') continue;
        if (/^(https?:|blob:)/i.test(raw.trim())) continue;
        const clean = raw.split('?')[0].trim().replace(/\\/g, '/').replace(/^\/+/, '');
        if (!clean) continue;
        if (clean.startsWith('widgets/')) return clean;
        if (clean.endsWith('.html')) return `widgets/${clean}`;
        return clean;
    }
    return '';
}

export function findWidgetFile(zipFile, widgetPath) {
    if (!zipFile || !widgetPath) return null;
    let file = zipFile.file(widgetPath);
    if (file) return file;
    const lower = widgetPath.toLowerCase();
    const ciMatches = zipFile.filter((relPath, f) => !f.dir && relPath.toLowerCase() === lower);
    if (ciMatches.length) return ciMatches[0];
    if (!widgetPath.startsWith('widgets/')) {
        file = zipFile.file(`widgets/${widgetPath}`);
        if (file) return file;
    }
    return null;
}
