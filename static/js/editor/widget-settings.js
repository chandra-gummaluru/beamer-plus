// Widget settings bridge — the parent half of the settings protocol.
//
// A widget declares what it can be configured with in its `widget-schema`
// block; those fields are edited in the editor's properties panel (see
// editor/widget-schema.js and editor/properties.js), which is the single place
// a widget is configured from. What remains here is the other direction: a
// widget writing its own settings back at runtime, and the files its fields
// own — a widget's settings belong in its slide config item, so they save and
// reload like everything else on the slide.
//
// Protocol
//   ← widget   widget-settings        { patch, remove } to merge into the item
//   ← widget   widget-asset-upload    a file field picked a file
//   → widget   widget-asset-saved     …and the path it was stored under
import { ctx, WIDGET_RESERVED } from './context.js';
import { postToWidget, widgetIdForWindow } from '../core/iframe-widget-renderer.js';
import { sessionUrl } from '../app/session.js';

export function initWidgetSettings() {
    window.addEventListener('message', onWidgetMessage);
}

/* ─── messages ──────────────────────────────────────────────────── */

const _HANDLED = new Set([
    'widget-settings', 'widget-asset-upload',
]);

function onWidgetMessage(e) {
    const data = e.data;
    if (!data || typeof data.type !== 'string' || !_HANDLED.has(data.type)) return;

    // These messages write to the presentation, so only accept them from a
    // window we can identify as one of our own widget iframes, speaking for
    // the widget it actually is.
    const sourceId = widgetIdForWindow(e.source);
    if (sourceId === null || sourceId !== String(data.widgetId)) return;

    if (data.type === 'widget-settings') {
        mergeSettings(sourceId, data);
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

/* ─── saving ────────────────────────────────────────────────────── */

/**
 * Ask every live widget to write out any file it owns. Called at the start of
 * a save: the uploads land while the rest of the ZIP is being built, so this
 * costs no extra wait, and a notebook edited during the talk is saved as the
 * notebook rather than as a blob inside the widget's state.
 */
export function requestWidgetFileFlush() {
    document.querySelectorAll('.widget-iframe').forEach(iframe => {
        try { iframe.contentWindow?.postMessage({ type: 'widget-flush-files' }, '*'); } catch (_) {}
    });
}

/* ─── file fields ───────────────────────────────────────────────── */

// A widget's file field hands us the bytes; we stash them for the save ZIP and
// POST them so the widget can read the file immediately, before any save.
async function storeAsset(widgetId, msg) {
    const item = findWidgetItem(widgetId);
    if (!item) return;
    const path = await saveWidgetAsset(item, msg);
    if (path === null) return;
    postToWidget(widgetId, { type: 'widget-asset-saved', key: msg.key, path });
}

/**
 * Stash a widget's file in the deck and record its path on the widget's config
 * item. Shared by the in-widget file field (above) and the editor panel's own
 * file rows, so both land the bytes in exactly the same place.
 *
 * msg: { key, buffer, name, folder = 'files', serve = true }
 * Returns the saved path, or null if the request was malformed.
 */
export async function saveWidgetAsset(item, msg) {
    if (!item) return null;
    const key = msg?.key;
    if (typeof key !== 'string' || WIDGET_RESERVED.has(key)) return null;
    if (!(msg.buffer instanceof ArrayBuffer)) return null;

    const name   = String(msg.name || 'file').split(/[\\/]/).pop().replace(/^\.+/, '') || 'file';
    const folder = String(msg.folder || 'files').replace(/\.\./g, '').replace(/^\/+|\/+$/g, '') || 'files';
    const path   = `${folder}/${name}`;

    ctx.state.editorNewFiles[path] = msg.buffer;

    // Upload so the file is servable over /api/zip-asset/ right away, before
    // any save. A widget that already holds the content can skip this.
    if (msg.serve !== false) {
        try {
            const fd = new FormData();
            fd.append('file', new File([msg.buffer], name));
            fd.append('folder', folder);
            await fetch(sessionUrl('/api/upload-asset'), { method: 'POST', body: fd });
        } catch (err) {
            console.warn('[editor] upload-asset POST failed (widget preview may not work):', err);
        }
    }

    item[key] = path;
    return path;
}
