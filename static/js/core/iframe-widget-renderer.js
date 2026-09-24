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
      try { parent.postMessage({ type: 'widget-nav', key: e.key }, '*'); } catch (_) {}
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
    if (e.data?.type === 'widget-state' && e.data.widgetId != null && e.data.state !== undefined) {
        _capturedStates.set(String(e.data.widgetId), e.data.state);
    }
});

// States loaded from ZIP to restore into freshly-created iframes
let _savedWidgetStates = {};

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
    const allIframes = new Map();
    document.querySelectorAll('.widget-iframe').forEach(iframe => {
        const wid = iframe.dataset.widgetId;
        if (wid) allIframes.set(wid, iframe);
    });

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
            if (e.data?.type === 'widget-state' && e.data.widgetId && e.data.state !== undefined) {
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
const _LAYOUT_KEYS = new Set(['x', 'y', 'width', 'height', 'zIndex', 'interactive']);

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
                widgetX: w.x, widgetY: w.y, widgetWidth: w.width, widgetHeight: w.height,
                widgetZIndex: w.zIndex || 10,
                widgetInteractive: w.interactive !== false ? 'true' : 'false',
            });
            const rect = container.getBoundingClientRect();
            existing.style.left          = `${w.x * rect.width}px`;
            existing.style.top           = `${w.y * rect.height}px`;
            existing.style.width         = `${w.width * rect.width}px`;
            existing.style.height        = `${w.height * rect.height}px`;
            existing.style.zIndex        = w.zIndex || 10;
            existing.style.pointerEvents = w.interactive !== false ? 'auto' : 'none';
            existing.style.opacity       = '1';  // make visible

            // After a short delay (browser reflow), fire resize and re-apply
            // captured state so canvas-based widgets redraw correctly.
            const widId = String(w.id);
            setTimeout(() => {
                try { existing.contentWindow?.dispatchEvent(new Event('resize')); } catch (_) {}
                const captured = _capturedStates.get(widId);
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

        container.appendChild(iframe);
        _widgetRegistry.set(String(w.id), { iframe, container, savedStyle: null });
        _ensureExpandListener();

        try {
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
                if (!widgetFile) {
                    console.error(`Widget file not found in zip: ${widgetPath}`);
                    iframe.srcdoc = `<div style="padding:20px;font-family:sans-serif;color:#666;">Widget not found: ${_escapeHtml(widgetPath)}</div>`;
                    return;
                }
                htmlContent = await widgetFile.async('string');
            }

            // Pre-load notebook from zip if widget config specifies a local path.
            // Remote URLs (http/https) are passed through as-is and fetched by the
            // widget itself, so we skip the ZIP lookup for those.
            let notebookContent = null;
            if (w.notebook && typeof w.notebook === 'string' && w.notebook.trim()) {
                const nb = w.notebook.trim();
                if (/^https?:\/\//i.test(nb)) {
                    // Remote URL — widget handles the fetch; nothing to pre-load here.
                } else {
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

            const _configPayload = _withPendingAssets({
                ...w,
                ...widgetSessionConfig(),
                role: viewerMode ? 'viewer' : 'presenter',
                ...(notebookContent !== null ? { notebookContent } : {}),
            });
            const _configJson   = JSON.stringify(_configPayload).replace(/<\/script>/gi, '<\\/script>');
            const _configScript = `<script>window.WIDGET_CONFIG=${_configJson};<\/script>`;
            // Inject shared base theme + widget config + settings kit right after <head>.
            // _WIDGET_BASE_INJECT comes first so each widget's own <style> wins over
            // defaults; the kit comes last because it reads window.WIDGET_CONFIG.
            const _injectedHtml = htmlContent.replace(
                /(<head[^>]*>)/i,
                `$1${_WIDGET_BASE_INJECT}${_configScript}${_SETTINGS_KIT_INJECT}`
            );

            await new Promise(resolve => {
                let settled = false;
                const finish = () => { if (!settled) { settled = true; resolve(); } };
                iframe.addEventListener('load', () => {
                    iframe.contentWindow.postMessage({ type: 'widget-config', config: _configPayload }, '*');
                    const savedState = _savedWidgetStates[w.id];
                    if (savedState !== undefined) {
                        iframe.contentWindow.postMessage({ type: 'widget-set-state', state: savedState }, '*');
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
