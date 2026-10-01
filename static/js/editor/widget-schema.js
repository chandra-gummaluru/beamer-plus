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
        fields,
    };
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
