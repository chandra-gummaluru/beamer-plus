// Widget settings bridge — the parent half of the settings protocol.
//
// A widget owns its own settings UI (see static/js/widget-settings-kit.js,
// injected into every widget iframe). Beamer+ owns three things about it:
// the gear on the widget's edit overlay, the room the widget needs to draw
// its panel, and persistence — a widget's settings still belong in its slide
// config item, so they save and reload like everything else on the slide.
//
// Protocol
//   → widget   widget-open-settings   gear clicked; show your settings
//   → widget   widget-close-settings  parent is tearing down; hide them
//   ← widget   widget-has-settings    announced on load; gates the gear
//   ← widget   widget-settings        { patch, remove } to merge into the item
//   ← widget   widget-settings-close  the widget closed its own panel
//   ← widget   widget-asset-upload    a file field picked a file
//   → widget   widget-asset-saved     …and the path it was stored under
import { ctx, WIDGET_RESERVED } from './context.js';
import { postToWidget, widgetIdForWindow } from '../core/iframe-widget-renderer.js';
import { sessionUrl } from '../app/session.js';

// widgetId → whether that widget has anything to show behind the gear.
const _hasSettings = new Map();

let _openWidgetId = null;

export function initWidgetSettings() {
    window.addEventListener('message', onWidgetMessage);
}

/* ─── gear state ────────────────────────────────────────────────── */

export function widgetHasSettings(widgetId) {
    return _hasSettings.get(String(widgetId)) === true;
}

// Overlays are built before a freshly-loaded widget has announced itself, so
// each gear starts hidden and is revealed when its widget says it has settings.
function syncGear(widgetId) {
    const sel = `.edit-overlay-gear[data-widget-id="${CSS.escape(String(widgetId))}"]`;
    document.querySelectorAll(sel).forEach(btn => { btn.hidden = !widgetHasSettings(widgetId); });
}

/* ─── settings mode ─────────────────────────────────────────────── */

export function isWidgetSettingsOpen() { return _openWidgetId !== null; }

// While settings are open the widget expands to fill the slide and the edit
// overlays step aside (body.widget-settings-open) so its panel is clickable —
// otherwise the overlay, which sits above the iframe to catch drags, would
// swallow every click meant for the widget.
export function openWidgetSettings(widgetId) {
    if (_openWidgetId !== null) closeWidgetSettings();
    if (!postToWidget(widgetId, { type: 'widget-open-settings' })) return;
    _openWidgetId = String(widgetId);
    document.body.classList.add('widget-settings-open');
}

export function closeWidgetSettings() {
    if (_openWidgetId === null) return;
    postToWidget(_openWidgetId, { type: 'widget-close-settings' });
    endSettingsMode();
}

function endSettingsMode() {
    _openWidgetId = null;
    document.body.classList.remove('widget-settings-open');
}

/* ─── messages ──────────────────────────────────────────────────── */

const _HANDLED = new Set([
    'widget-has-settings', 'widget-settings', 'widget-settings-close', 'widget-asset-upload',
]);

function onWidgetMessage(e) {
    const data = e.data;
    if (!data || typeof data.type !== 'string' || !_HANDLED.has(data.type)) return;

    // These messages write to the presentation, so only accept them from a
    // window we can identify as one of our own widget iframes, speaking for
    // the widget it actually is.
    const sourceId = widgetIdForWindow(e.source);
    if (sourceId === null || sourceId !== String(data.widgetId)) return;

    if (data.type === 'widget-has-settings') {
        _hasSettings.set(sourceId, data.has === true);
        syncGear(sourceId);
    } else if (data.type === 'widget-settings') {
        mergeSettings(sourceId, data);
    } else if (data.type === 'widget-settings-close') {
        if (_openWidgetId === sourceId) endSettingsMode();
    } else if (data.type === 'widget-asset-upload') {
        storeAsset(sourceId, data);
    }
}

// Find a widget's config item by id. Scans every slide's config rather than
// just the current one: in split view a widget on the other pane is equally
// live, and a settings write must land on the right item either way.
function findWidgetItem(widgetId) {
    const id = String(widgetId);
    const configs = ctx.state?.slideConfigs;
    if (!configs) return null;
    for (const key of Object.keys(configs)) {
        const list = configs[key]?.widgets;
        if (!Array.isArray(list)) continue;
        const item = list.find(w => String(w?.id) === id);
        if (item) return item;
    }
    return null;
}

function mergeSettings(widgetId, msg) {
    const item = findWidgetItem(widgetId);
    if (!item) return;
    const patch = (msg.patch && typeof msg.patch === 'object') ? msg.patch : {};
    for (const key of Object.keys(patch)) {
        if (WIDGET_RESERVED.has(key)) continue;   // a widget can't move or re-point itself
        item[key] = patch[key];
    }
    for (const key of (Array.isArray(msg.remove) ? msg.remove : [])) {
        if (typeof key === 'string' && !WIDGET_RESERVED.has(key)) delete item[key];
    }
}

/* ─── file fields ───────────────────────────────────────────────── */

// A widget's file field hands us the bytes; we stash them for the save ZIP and
// POST them so the widget can read the file immediately, before any save.
async function storeAsset(widgetId, msg) {
    const item = findWidgetItem(widgetId);
    if (!item) return;
    const key = msg.key;
    if (typeof key !== 'string' || WIDGET_RESERVED.has(key)) return;
    if (!(msg.buffer instanceof ArrayBuffer)) return;

    const name   = String(msg.name || 'file').split(/[\\/]/).pop().replace(/^\.+/, '') || 'file';
    const folder = String(msg.folder || 'files').replace(/\.\./g, '').replace(/^\/+|\/+$/g, '') || 'files';
    const path   = `${folder}/${name}`;

    ctx.state.editorNewFiles[path] = msg.buffer;

    try {
        const fd = new FormData();
        fd.append('file', new File([msg.buffer], name));
        fd.append('folder', folder);
        await fetch(sessionUrl('/api/upload-asset'), { method: 'POST', body: fd });
    } catch (err) {
        console.warn('[editor] upload-asset POST failed (widget preview may not work):', err);
    }

    item[key] = path;
    postToWidget(widgetId, { type: 'widget-asset-saved', key, path });
}
