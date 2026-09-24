// Save — rebuilds the presentation ZIP from the in-memory state (slide
// configs, slide order, annotations, widget states, newly added files) and
// downloads it.
import { collectWidgetStates, getLoadedWidgetStates } from '../core/iframe-widget-renderer.js';
import { requestWidgetFileFlush } from './widget-settings.js';
import { ctx } from './context.js';

// Custom widgets are added with an ephemeral `blob:` URL as their `src` (for
// immediate in-session preview), while the .html bytes are stashed in
// editorNewFiles as `widgets/<name>.html`. A blob URL is dead once the page is
// reloaded or the deck is re-opened, so it must never be persisted. Rewrite any
// blob src to the widget's ZIP-relative path so future loads resolve from disk.
// Returns a shallow-cloned config; the live in-memory config is left untouched
// (its blob URL is still valid for the current session).
function normalizeWidgetSrcs(cfg) {
    if (!Array.isArray(cfg?.widgets) || !cfg.widgets.some(w => /^blob:/i.test(w?.src || ''))) {
        return cfg;
    }
    return {
        ...cfg,
        widgets: cfg.widgets.map(w => {
            if (!/^blob:/i.test(w?.src || '')) return w;
            const { src, ...rest } = w;
            // The uploaded file is saved as `widgets/<type>.html`; the loader's
            // path resolver looks there for a widget of this type.
            return w.type ? { ...rest, src: `widgets/${w.type}.html` } : rest;
        }),
    };
}

export async function savePresentation() {
    if (!ctx.state.zipFile) {
        window.BeamerModal?.show({ kind: 'error', title: 'Nothing to save', message: 'No presentation loaded.' });
        return;
    }
    const modal = window.BeamerModal;
    modal?.show({ kind: 'loading', title: 'Saving…', message: 'Building ZIP…' });
    try {
        // Ask file-owning widgets to write their files out now; the uploads
        // arrive while we copy the rest of the ZIP below.
        requestWidgetFileFlush();
        // Flush the current canvas so the latest strokes are captured.
        if (ctx.state.annCvs?.canvas) {
            ctx.state.annotations[ctx.state.currentSlide] = ctx.state.annCvs.canvas.toDataURL('image/png');
        }
        if (ctx.state.splitView && ctx.state.annCvs2?.canvas) {
            ctx.state.annotations[ctx.state.rightSlideIndex] = ctx.state.annCvs2.canvas.toDataURL('image/png');
        }

        // Which slide configs belong in the deck: one per PDF page and blank
        // actually in the structure. A slide deleted this session takes its
        // config (and its widgets' saved state) with it.
        const liveKeys = new Set();
        for (const obj of ctx.state.slideStructure) {
            if (obj?.type === 'pdf')                  liveKeys.add(String(obj.pdfIndex));
            else if (obj?.type === 'blank' && obj.blankId) liveKeys.add(String(obj.blankId));
        }
        const cfgs = ctx.state.slideConfigs;
        const inMemory = (key) => Object.prototype.hasOwnProperty.call(cfgs, key) && cfgs[key];
        const widgetIds = new Set();
        const noteWidgets = (cfg) => {
            for (const w of (Array.isArray(cfg?.widgets) ? cfg.widgets : [])) {
                if (w?.id != null) widgetIds.add(String(w.id));
            }
        };

        const newZip = new JSZip();

        for (const path of Object.keys(ctx.state.zipFile.files)) {
            const f = ctx.state.zipFile.file(path);
            if (!f || f.dir) continue;
            // Rewritten below from in-memory state. (Checked before the
            // config/s*.json pattern — slide-order.json matches it too.)
            if (path === 'config/slide-order.json') continue;
            if (path === 'config/annotations.json') continue;
            if (path === 'config/widget-states.json') continue;
            const m = /^config\/s(.+)\.json$/.exec(path);
            if (m) {
                const key = m[1];
                if (!liveKeys.has(key)) continue;   // its slide is gone
                if (inMemory(key)) continue;        // newer copy written below
                // Configs load lazily, only when a slide is first shown, so
                // any slide not opened this session has none in memory. Carry
                // its file over as-is — this used to be skipped, which dropped
                // every widget, video and model on those slides.
                const text = await f.async('string');
                newZip.file(path, text);
                try { noteWidgets(JSON.parse(text)); } catch (_) { /* kept verbatim anyway */ }
                continue;
            }
            newZip.file(path, await f.async('uint8array'));
        }

        for (const [key, cfg] of Object.entries(cfgs)) {
            if (!cfg || !liveKeys.has(String(key))) continue;
            newZip.file(`config/s${key}.json`, JSON.stringify(normalizeWidgetSrcs(cfg), null, 2));
            noteWidgets(cfg);
        }

        const isDefault = ctx.state.slideStructure.every((obj, i) => obj.type === 'pdf' && obj.pdfIndex === i);
        if (!isDefault) newZip.file('config/slide-order.json', JSON.stringify(ctx.state.slideStructure));

        // Save annotations so pen strokes persist across re-uploads.
        const nonEmptyAnnotations = Object.fromEntries(
            Object.entries(ctx.state.annotations).filter(([, v]) => v && v.length > 100)
        );
        if (Object.keys(nonEmptyAnnotations).length > 0) {
            newZip.file('config/annotations.json', JSON.stringify(nonEmptyAnnotations));
        }

        // Save widget states so interactive widgets resume where they left off:
        // the live state for every widget that's running, and for the rest —
        // widgets on slides not opened this session — the state they were
        // loaded with, so a save doesn't reset them. Only widgets still in
        // the deck are kept.
        const live = await collectWidgetStates(1500);
        const loaded = getLoadedWidgetStates();
        const widgetStates = {};
        for (const id of widgetIds) {
            if (live[id] !== undefined)        widgetStates[id] = live[id];
            else if (loaded[id] !== undefined) widgetStates[id] = loaded[id];
        }
        if (Object.keys(widgetStates).length > 0) {
            newZip.file('config/widget-states.json', JSON.stringify(widgetStates));
        }

        for (const [path, buffer] of Object.entries(ctx.state.editorNewFiles)) {
            newZip.file(path, buffer);
        }

        const blob = await newZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'), { href: url, download: 'presentation-edited.zip' });
        a.click();
        URL.revokeObjectURL(url);
        modal?.close();
    } catch (err) {
        modal?.close();
        window.BeamerModal?.show({ kind: 'error', title: 'Save failed', message: err.message });
    }
}
