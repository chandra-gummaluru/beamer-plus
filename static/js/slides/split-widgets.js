// Split widgets — one widget across the two slides of a split view.
//
// A split widget belongs to a view slide: its one config item lives in the
// view's own config (configKeyOf(view) is its viewId, saved as
// config/sv<id>.json), and it fills both of the view's slides, one half on
// each — for the Python workspace, the code on the left slide and the shell,
// memory model or debugger on the right.
//
// It is ONE widget with ONE iframe, never two copies kept in sync. The iframe
// lives in a layer over the whole stage (not inside either slide), so it is
// never moved or reloaded, and is laid over whichever of its halves are on
// screen: clipped (clip-path) to just those slide rectangles, so the divider
// and everything outside them stay clickable. The widget is told where each
// half is ({ type: 'widget-split', live, left, right }, rects in its own px)
// and puts its panes there.
//
//   both slides on screen, each in its own pane   live: one widget, working
//   only one of them on screen (the slide alone,  static: that half shown as
//     or in some other split)                       it was left, not clickable
//   neither                                       parked like any widget off
//                                                   screen (state kept)
//
// Who is where is read off the stage itself (the slide each pane's container
// says it shows), so this follows every way of getting there — navigation,
// the split button, a view's slides being re-picked — without each of those
// having to tell it.
import { bus } from '../core/events.js';
import { slideUid } from './structure.js';
import { renderWidgets, parkWidgets, widgetConfigSignature } from '../core/iframe-widget-renderer.js';

let _state = null;
let _layer = null;
let _queued = false;
let _rafLoop = 0;
let _syncing = null;             // the sync in flight (they never overlap)
let _again = false;
// What each split iframe was last told, so nothing is re-sent unchanged:
// widget id → JSON of { live, left, right, box }.
const _told = new Map();

const _key = (id) => 'split:' + id;

/** The split widgets of a view, from its config (empty if none / not loaded). */
export function splitWidgetsOf(view) {
    const cfg = view?.viewId ? _state?.slideConfigs?.[view.viewId] : null;
    return (Array.isArray(cfg?.widgets) ? cfg.widgets : []).filter(w => w && w.split);
}

export function initSplitWidgets(state) {
    _state = state;
    const main = document.getElementById('main-content');
    if (!main) return;
    _layer = document.createElement('div');
    _layer.id = 'split-widget-layer';
    // After both panes: above each slide and its widgets, below the ink
    // (slides.css).
    main.appendChild(_layer);

    // Which slide each pane shows is written on its container when a render
    // finishes (data-slide-key), and the split opens and closes with a body
    // class: watching those catches every way the stage changes.
    const mo = new MutationObserver(queueSync);
    for (const id of ['pdf-canvas', 'pdf-canvas-2']) {
        const el = document.getElementById(id);
        if (el) mo.observe(el, { attributes: true, attributeFilter: ['data-slide-key'] });
    }
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    for (const ev of ['slide:changed', 'split:resized', 'slides:remapped', 'slides:reordered',
                      'widgets:changed', 'split-widgets:changed']) bus.on(ev, queueSync);
    bus.on('deck:loaded', () => { _told.clear(); _placed.clear(); _loads.clear(); queueSync(); });
    window.addEventListener('resize', queueSync);
}

/** Look again at what's on stage, on the next frame (many changes come in a burst). */
export function queueSync() {
    if (_queued) return;
    _queued = true;
    requestAnimationFrame(() => { _queued = false; runSync(); });
}

function runSync() {
    if (_syncing) { _again = true; return; }
    _syncing = sync().catch(err => console.error('[split-widgets]', err)).finally(() => {
        _syncing = null;
        if (_again) { _again = false; queueSync(); }
    });
}

// A view config the deck has but that hasn't been opened this session.
const _loads = new Map();   // key → Promise
export function loadSplitConfig(key) {
    if (!key || !_state) return Promise.resolve(null);
    if (_state.slideConfigs[key] !== undefined) return Promise.resolve(_state.slideConfigs[key]);
    if (_loads.has(key)) return _loads.get(key);
    const zip = _state.zipFile, configs = _state.slideConfigs;
    let done;
    _loads.set(key, new Promise(r => { done = r; }));
    (async () => {
        let cfg = null;
        try {
            const f = zip?.file(`config/s${key}.json`);
            if (f) cfg = JSON.parse(await f.async('string'));
        } catch (_) { cfg = null; }
        // Another deck opened meanwhile: this one's config isn't wanted.
        if (_state.zipFile === zip && _state.slideConfigs === configs && configs[key] === undefined) configs[key] = cfg;
        _loads.delete(key);
        done(configs[key] ?? null);
        queueSync();
    })();
    return _loads.get(key);
}

// The slide a pane shows right now, by its uid, and the element it's drawn in.
function paneSlides() {
    const out = [];
    const left = document.getElementById('pdf-canvas');
    if (left?.dataset.slideKey) out.push({ uid: left.dataset.slideKey.slice(2), el: left, pane: 'left' });
    if (_state.splitView) {
        const right = document.getElementById('pdf-canvas-2');
        if (right?.dataset.slideKey) out.push({ uid: right.dataset.slideKey.slice(2), el: right, pane: 'right' });
    }
    return out;
}

function splitIframes() {
    return _layer ? [..._layer.querySelectorAll('.widget-iframe')] : [];
}

async function sync() {
    if (!_layer || !_state) return;
    if (!_state.zipFile) { splitIframes().forEach(hide); return; }

    const panes = paneSlides();
    const want = new Map();   // widget id → { w, halves: { left?, right? }, live }

    // A slide shows one split widget's half at most. Two views can share a
    // slide (a duplicated view shares both): the view on stage wins, then
    // the one earliest in the deck.
    const views = (_state.slideStructure || []).filter(v => v?.type === 'view' && v.viewId);
    const onStage = _state.splitView ? _state.slideStructure?.[_state.currentViewIndex] : null;
    if (onStage && views.includes(onStage)) views.splice(views.indexOf(onStage), 1), views.unshift(onStage);
    const claimed = new Set();

    for (const view of views) {
        if (_state.slideConfigs[view.viewId] === undefined) { loadSplitConfig(view.viewId); continue; }
        const widgets = splitWidgetsOf(view);
        if (!widgets.length) continue;
        const L = _state.slideStructure[view.left], R = _state.slideStructure[view.right];
        const lUid = L && L.type !== 'view' ? slideUid(L) : null;
        const rUid = R && R.type !== 'view' ? slideUid(R) : null;
        const halves = {};
        let live = false;
        for (const p of panes) {
            if (claimed.has(p.uid)) continue;
            if (lUid && p.uid === lUid && !halves.left)  halves.left  = p;
            if (rUid && p.uid === rUid && !halves.right) halves.right = p;
        }
        if (halves.left)  claimed.add(halves.left.uid);
        if (halves.right) claimed.add(halves.right.uid);
        // Live only with both halves on screen, each where it belongs: the
        // left half in the left pane and the right half in the right.
        if (halves.left?.pane === 'left' && halves.right?.pane === 'right') live = true;
        for (const w of widgets) want.set(String(w.id), { w, halves, live });
    }

    // Widgets that are gone (deleted, or their view was) go with their iframe.
    for (const f of splitIframes()) {
        if (!want.has(f.dataset.widgetId)) remove(f);
    }

    for (const [id, { w, halves, live }] of want) {
        const any = halves.left || halves.right;
        let f = findIframe(id);
        if (!any) { if (f) hide(f); continue; }
        if (!f || f.dataset.widgetSig !== widgetConfigSignature(w)) {
            // First time on screen (or its settings changed in a way that
            // needs a rebuild): build it. renderWidgets also restores the
            // state the deck saved for it.
            _told.delete(id);
            await renderWidgets({ widgets: [w] }, _layer, _state.zipFile, false, _key(id));
            f = findIframe(id);
            if (!f) continue;
            f.classList.add('widget-iframe--split');
            f.addEventListener('load', () => { _told.delete(id); queueSync(); });
        }
        place(f, id, halves, live);
    }

    // Keep up with the slides while any half is on screen: the stage slides
    // and resizes in transitions (opening the split, the settings sheet, the
    // divider) that end without an event.
    const anyShown = splitIframes().some(f => f.style.opacity !== '0');
    if (anyShown && !_rafLoop) _rafLoop = requestAnimationFrame(follow);
}

function follow() {
    _rafLoop = 0;
    if (!_syncing) {
        // Cheap: re-place what's shown from where the slides are now.
        const panes = paneSlides();
        let shown = false;
        for (const f of splitIframes()) {
            if (f.style.opacity === '0') continue;
            shown = true;
            const t = _placed.get(f.dataset.widgetId);
            if (!t) continue;
            const halves = {};
            for (const side of ['left', 'right']) {
                const p = t.halves[side] && panes.find(q => q.pane === t.halves[side].pane);
                if (p) halves[side] = p;
            }
            place(f, f.dataset.widgetId, halves, t.live);
        }
        if (!shown) return;
    }
    _rafLoop = requestAnimationFrame(follow);
}

function findIframe(id) {
    return _layer?.querySelector(`.widget-iframe[data-widget-id="${CSS.escape(String(id))}"]`) || null;
}

const _placed = new Map();   // widget id → { halves, live } last placed

function place(f, id, halves, live) {
    _placed.set(id, { halves, live });
    const host = _layer.getBoundingClientRect();
    const rects = {};
    for (const side of ['left', 'right']) {
        const p = halves[side];
        if (!p) continue;
        const r = p.el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        rects[side] = { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height };
    }
    const sides = Object.values(rects);
    if (!sides.length) { hide(f); return; }

    // The iframe covers both halves (and the gap between them); the clip
    // leaves only the halves themselves.
    const x0 = Math.min(...sides.map(r => r.x)), y0 = Math.min(...sides.map(r => r.y));
    const x1 = Math.max(...sides.map(r => r.x + r.w)), y1 = Math.max(...sides.map(r => r.y + r.h));
    const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const rel = (r) => r && { x: r.x - x0, y: r.y - y0, w: r.w, h: r.h };
    const msg = { type: 'widget-split', live, left: rel(rects.left) || null, right: rel(rects.right) || null };
    // The editor previews a split without letting its widgets be used, as it
    // does every widget in a split view (slides.css).
    const interactive = live && !document.body.classList.contains('edit-mode');

    const sig = JSON.stringify([msg, box, interactive]);
    const wasHidden = f.style.opacity === '0';
    if (_told.get(id) === sig && !wasHidden) return;
    _told.set(id, sig);

    const r1 = (v) => Math.round(v * 100) / 100;
    Object.assign(f.style, {
        left: `${r1(box.x)}px`, top: `${r1(box.y)}px`,
        width: `${r1(box.w)}px`, height: `${r1(box.h)}px`,
        clipPath: `path('${[msg.left, msg.right].filter(Boolean)
            .map(r => `M${r1(r.x)} ${r1(r.y)}H${r1(r.x + r.w)}V${r1(r.y + r.h)}H${r1(r.x)}Z`).join(' ')}')`,
        // Static halves are a picture: nothing on them reacts.
        pointerEvents: interactive ? 'auto' : 'none',
        opacity: '1',
        zIndex: '1',
    });
    f.dataset.splitLive = live ? 'true' : 'false';
    // Until it is first placed the iframe is laid over the whole stage;
    // slides.css keeps it invisible till then.
    f.dataset.splitPlaced = 'true';
    f.tabIndex = interactive ? 0 : -1;
    if (!interactive && document.activeElement === f) f.blur();
    try { f.contentWindow?.postMessage(msg, '*'); } catch (_) {}
    if (wasHidden) {
        try { f.contentWindow?.postMessage({ type: 'widget-shown' }, '*'); } catch (_) {}
    }
}

function hide(f) {
    if (f.style.opacity === '0') return;
    _told.delete(f.dataset.widgetId);
    delete f.dataset.splitLive;
    // Off screen like a slide's widgets when their slide is left: kept alive,
    // told it's hidden, its state captured.
    f.dataset.widgetSlide = f.dataset.widgetSlide || _key(f.dataset.widgetId);
    parkWidgets(_layer, f.dataset.widgetSlide);
}

function remove(f) {
    _told.delete(f.dataset.widgetId);
    _placed.delete(f.dataset.widgetId);
    try { f.contentWindow?.postMessage({ type: 'widget-cleanup' }, '*'); } catch (_) {}
    f.remove();
}
