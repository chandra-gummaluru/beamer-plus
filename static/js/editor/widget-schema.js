// Widget schema reader — the parent's copy of a widget's own field list.
//
// Every widget declares what it can be configured with in a JSON block:
//
//   <script id="widget-schema" type="application/json">
//   { "label": "...", "fields": [ { "key": ..., "label": ..., "type": ... } ] }
//   </script>
//
// The settings kit inside the iframe reads that block to draw the widget's own
// panel. The editor reads it here, from the widget's HTML directly, so the
// properties panel can offer the same fields without a live iframe — which
// matters because a widget added in edit mode has no iframe yet (it is only
// created when the slide re-renders on exit), and because edit mode hides
// widget iframes outright.
//
// The HTML comes from wherever the widget itself would be loaded from: the
// server for a built-in, the deck's ZIP (or the pending-files map) for one the
// presenter supplied.
import { ctx, WIDGET_RESERVED } from './context.js';
import { resolveWidgetPath, findWidgetFile } from '../core/iframe-widget-renderer.js';

// cache key → Promise<{ label, customSettings, fields } | null>. Keyed by
// source rather than by widget id: two survey widgets share one schema, and
// the fetch should happen once per deck.
const _cache = new Map();

function cacheKey(item) {
    if (!item) return null;
    if (item.builtin && item.type) return `builtin:${item.type}`;
    if (/^blob:/i.test(item.src || '')) return `blob:${item.src}`;
    const path = resolveWidgetPath(item);
    return path ? `file:${path}` : null;
}

/** Read a widget's declared fields. Resolves null if it declares none. */
export function getWidgetSchema(item) {
    const key = cacheKey(item);
    if (!key) return Promise.resolve(null);
    if (!_cache.has(key)) {
        _cache.set(key, loadSchema(item).catch(err => {
            console.warn('[editor] could not read widget schema:', err);
            return null;
        }));
    }
    return _cache.get(key);
}

/** Drop the cache — a re-uploaded widget of the same type may declare different fields. */
export function clearWidgetSchemaCache() {
    _cache.clear();
}

async function loadSchema(item) {
    const html = await loadWidgetHtml(item);
    if (!html) return null;

    // Matched with a regex rather than DOMParser: parsing the document would
    // resolve the widget's own <script src> and <img> URLs, and we only want
    // one inert JSON island out of it.
    const m = html.match(/<script\b[^>]*\bid=["']widget-schema["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return null;

    let schema;
    try { schema = JSON.parse(m[1].trim()); }
    catch (err) { console.warn('[editor] widget-schema is not valid JSON:', err); return null; }

    const fields = Array.isArray(schema?.fields)
        // The layout keys belong to Beamer+, not to the widget — the same list
        // the kit and the settings bridge enforce.
        ? schema.fields.filter(f => f && typeof f.key === 'string' && !WIDGET_RESERVED.has(f.key))
        : [];

    // Every widget has a Name: its title in the bar, inside any PDF it
    // exports, and on any file it downloads. Added here (and in the settings
    // kit) rather than declared per widget, so no widget can forget it. A
    // widget that declares its own `title` field keeps that one.
    if (!fields.some(f => f.key === 'title')) fields.unshift(nameField(schema?.label));

    // Every widget also gets a Text size: the default for the top bar's
    // stepper, offering the same steps. A widget's own `scale` field is
    // replaced by it (keeping its default), so all widgets offer one set of
    // sizes. Skipped for widgets that opt out of the stepper (fontSize: false).
    if (schema?.fontSize !== false) {
        const own = fields.findIndex(f => f.key === 'scale');
        const def = own >= 0 && fields[own].default != null ? String(fields[own].default) : '1.4';
        if (own >= 0) fields.splice(own, 1);
        fields.splice(fields.findIndex(f => f.key === 'title') + 1, 0, textSizeField(def));
    }

    return {
        label: typeof schema?.label === 'string' ? schema.label : null,
        customSettings: !!schema?.customSettings,
        // Only works as the whole slide (a notebook, a workspace, a circuit
        // canvas): the editor locks its box to fill the slide.
        fullSlide: schema?.fullSlide === true,
        // How it can be shown — see widgetModes() below.
        modes: widgetModes(schema),
        modesDeclared: !schema?.fullSlide && Array.isArray(schema?.modes) && widgetModes(schema).length > 0,
        overlaySize: overlaySize(schema),
        fields,
    };
}

/* ─── display: full or overlay ───────────────────────────────────────── */
// A widget declares how it can be shown with "modes" (first is the default):
//   "full"     the slide's content — the whole slide, with the shared bar
//   "overlay"  a small tool over part of a slide — no bar, a simplified view
// "fullSlide": true is shorthand for ["full"], and so is declaring nothing.
// Keep these in step with declaredModes() / displayMode() in
// widget-settings-kit.js, which makes the same call inside the iframe.

const DISPLAY_MODES = ['full', 'overlay'];

/** The modes a schema supports, in its order. Never empty. */
export function widgetModes(schema) {
    if (!schema || schema.fullSlide === true) return ['full'];
    const m = Array.isArray(schema.modes) ? schema.modes.filter(x => DISPLAY_MODES.includes(x)) : [];
    return m.length ? [...new Set(m)] : ['full'];
}

const _near = (a, b) => Math.abs((+a || 0) - b) < 0.005;
export function boxIsFull(item) {
    return _near(item?.x, 0) && _near(item?.y, 0)
        && _near(item?.width ?? 1, 1) && _near(item?.height ?? 1, 1);
}

/** How a placed widget is shown: its saved `display`, else its default. */
export function widgetDisplay(item, schema) {
    const modes = schema?.modes || widgetModes(schema);
    if (modes.includes(item?.display)) return item.display;
    if (modes.length === 1) return modes[0];
    // Saved before modes existed: placed on part of the slide, it was being
    // used as an overlay.
    return boxIsFull(item) ? 'full' : 'overlay';
}

/** Does the editor pin this widget's box to the whole slide? */
export function isPinnedFull(item, schema) {
    if (!schema) return false;
    if (schema.fullSlide) return true;
    return !!schema.modesDeclared && widgetDisplay(item, schema) === 'full';
}

/** The box an overlay starts at: the schema's "overlaySize", else a third of the slide. */
function overlaySize(schema) {
    const o = schema?.overlaySize;
    const ok = v => typeof v === 'number' && v > 0.05 && v <= 1;
    return { width: ok(o?.width) ? o.width : 0.34, height: ok(o?.height) ? o.height : 0.34 };
}

/**
 * Switch a placed widget between full and overlay, giving it the matching
 * box: the whole slide, or an overlay-sized box in the middle (an overlay
 * that already has a box of its own keeps it).
 */
export function setWidgetDisplay(item, schema, display) {
    item.display = display;
    if (display === 'full') {
        Object.assign(item, { x: 0, y: 0, width: 1, height: 1 });
    } else if (boxIsFull(item)) {
        const { width, height } = schema?.overlaySize || overlaySize(schema);
        Object.assign(item, { width, height, x: (1 - width) / 2, y: (1 - height) / 2 });
    }
}

/** The steps of the top bar's text-size stepper (SCALE_STEPS in widget-settings-kit.js). */
export const TEXT_SIZES = ['1', '1.2', '1.4', '1.7', '2', '2.4'];

/** The universal Text size field. Keep in step with textSizeField() in widget-settings-kit.js. */
export function textSizeField(def = '1.4') {
    return {
        key: 'scale',
        label: 'Text size',
        type: 'select',
        options: TEXT_SIZES.map(v => ({ v, l: `${Math.round(parseFloat(v) * 100)}%` })),
        default: def,
    };
}

/** The universal Name field. Keep in step with nameField() in widget-settings-kit.js. */
export function nameField(label) {
    return {
        key: 'title',
        label: 'Name',
        type: 'text',
        placeholder: (typeof label === 'string' && label) ? label : 'Title and download file name',
    };
}

async function loadWidgetHtml(item) {
    if (item?.builtin && item.type) {
        const res = await fetch(`/widgets/${encodeURIComponent(item.type)}.html`);
        if (!res.ok) throw new Error(`built-in widget not found: ${item.type} (${res.status})`);
        return res.text();
    }

    // A custom widget uploaded this session is still only a blob URL plus the
    // bytes waiting in editorNewFiles; both resolve without touching the ZIP.
    if (/^blob:/i.test(item?.src || '')) {
        const res = await fetch(item.src);
        if (res.ok) return res.text();
    }

    const path = resolveWidgetPath(item);
    if (!path) return null;

    const pending = ctx.state?.editorNewFiles?.[path];
    if (pending) return new TextDecoder().decode(pending);

    const file = findWidgetFile(ctx.state?.zipFile, path);
    return file ? file.async('string') : null;
}
