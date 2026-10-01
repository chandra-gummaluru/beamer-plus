// Reveal steps — parts of a slide uncovered one press at a time.
//
// A slide's config may hold `reveals`: boxes (slide-relative x/y/width/height,
// like every other overlay) each with a `step` number. Media and widgets may
// also carry a `step`, meaning "appear on step N". While presenting, the
// slide starts with every step hidden; Right/PageDown uncovers the next step
// before it moves on, Left/PageUp hides the last one again. Arriving at a
// slide by going *back* shows everything, as Beamer's \pause does.
//
//   { "reveals": [ { "id": "r1", "x": 0.1, "y": 0.5, "width": 0.8,
//                    "height": 0.3, "step": 1, "style": "blend", "zIndex": 4 } ] }
//
// zIndex places the box among the slide's media (5) and widgets (10): the
// default 4 sits behind them, 11+ covers them too. Ink is always hidden under
// a closed box whatever its layer — the annotation canvas is masked there.
//
// "blend" fills the box with the slide's own colour around it, so a hidden
// region looks like empty slide; "frosted" is a visible frosted panel.
// In edit mode nothing is hidden — the editor draws the boxes as outlines.
import { configKeyOf, slideUid } from './structure.js';

let _state = null;
const _shown = new Map();   // slide uid → how many steps are uncovered

export function initReveals(state) { _state = state; }

const cfgOf = (obj) => {
    const key = configKeyOf(obj);
    return key == null ? null : _state.slideConfigs[key] || null;
};

/** The distinct step numbers on a slide, ascending. */
export function stepsOf(cfg) {
    if (!cfg) return [];
    const set = new Set();
    const add = (it) => { const n = parseInt(it?.step, 10); if (n > 0) set.add(n); };
    (cfg.reveals || []).forEach(add);
    for (const k of ['widgets', 'videos', 'audios', 'models']) (cfg[k] || []).forEach(add);
    return [...set].sort((a, b) => a - b);
}

/** Called when navigation lands on a slide: going back shows it all. */
export function resetRevealsOnArrival(obj, direction) {
    if (!obj) return;
    _shown.set(slideUid(obj), direction === 'back' ? Infinity : 0);
}

function shownCount(obj, total) {
    const n = _shown.get(slideUid(obj)) ?? 0;
    return Math.max(0, Math.min(total, n));
}

/**
 * Draw the slide's cover boxes into `container` (the slide's media layer)
 * and hide not-yet-reached media. Called at the end of every slide render.
 */
export function renderReveals(container, obj, slideKey) {
    if (!container) return;
    container.querySelectorAll('.reveal-cover').forEach(el => el.remove());
    container.dataset.revealSlide = obj ? slideUid(obj) : '';
    const cfg = cfgOf(obj);
    const reveals = cfg?.reveals || [];
    for (const r of reveals) {
        const el = document.createElement('div');
        el.className = 'reveal-cover' + (r.style === 'frosted' ? ' reveal-cover--frosted' : '');
        el.dataset.revealStep = String(parseInt(r.step, 10) || 1);
        Object.assign(el.style, {
            left: `${(r.x ?? 0) * 100}%`,
            top: `${(r.y ?? 0) * 100}%`,
            width: `${(r.width ?? 0.3) * 100}%`,
            height: `${(r.height ?? 0.2) * 100}%`,
            zIndex: String(parseInt(r.zIndex, 10) || 4),
        });
        el.dataset.box = [r.x ?? 0, r.y ?? 0, r.width ?? 0.3, r.height ?? 0.2].join(',');
        if (r.style !== 'frosted') el.style.background = sampleColour(container, r);
        container.appendChild(el);
    }
    tagSteppedMedia(container, cfg, slideKey);
    applyVisibility(container, obj, false);
}

// Mark media / widget elements that "appear on step N".
function tagSteppedMedia(container, cfg, slideKey) {
    if (!cfg) return;
    const tag = (el, item) => {
        if (!el) return;
        const n = parseInt(item?.step, 10);
        if (n > 0) el.dataset.revealStep = String(n);
        else delete el.dataset.revealStep;
    };
    const vids = container.querySelectorAll('.slide-video');
    (cfg.videos || []).forEach((v, i) => tag(vids[i], v));
    const auds = container.querySelectorAll('.slide-audio');
    (cfg.audios || []).forEach((a, i) => tag(auds[i], a));
    const mods = container.querySelectorAll('model-viewer');
    (cfg.models || []).forEach((m, i) => tag(mods[i], m));
    (cfg.widgets || []).forEach(w => {
        const sel = `.widget-iframe[data-widget-id="${CSS.escape(String(w.id))}"]` +
                    (slideKey ? `[data-widget-slide="${CSS.escape(slideKey)}"]` : '');
        tag(container.querySelector(sel), w);
    });
}

function applyVisibility(container, obj, animate = true) {
    const steps = stepsOf(cfgOf(obj));
    const shown = shownCount(obj, steps.length);
    const reached = new Set(steps.slice(0, shown));
    container.classList.toggle('reveal-animate', animate);
    const covers = [];
    container.querySelectorAll('[data-reveal-step]').forEach(el => {
        const n = parseInt(el.dataset.revealStep, 10);
        const visible = reached.has(n);
        if (el.classList.contains('reveal-cover')) {
            el.classList.toggle('is-revealed', visible);
            if (el.dataset.box) covers.push({ key: el.dataset.box, open: visible });
        } else el.classList.toggle('is-step-hidden', !visible);
    });
    maskInk(container, covers, animate);
    return { shown, total: steps.length };
}

/**
 * Uncover (+1) or re-cover (-1) one step on the slides on stage. Returns
 * true if it did something — the caller then doesn't change slide.
 */
export function stepReveal(dir) {
    if (!_state || _state.editMode) return false;
    const panes = [{ idx: _state.currentSlide, el: document.getElementById('pdf-canvas') }];
    if (_state.splitView) panes.push({ idx: _state.rightSlideIndex, el: document.getElementById('pdf-canvas-2') });
    const order = dir > 0 ? panes : panes.slice().reverse();
    for (const { idx, el } of order) {
        const obj = _state.slideStructure[idx];
        const total = stepsOf(cfgOf(obj)).length;
        if (!obj || !total) continue;
        const shown = shownCount(obj, total);
        if (dir > 0 ? shown >= total : shown <= 0) continue;
        _shown.set(slideUid(obj), shown + dir);
        if (el && el.dataset.revealSlide === slideUid(obj)) applyVisibility(el, obj, true);
        updateStepBadge();
        return true;
    }
    return false;
}

/** "2/4" next to the current slide's number in the navigator. */
export function updateStepBadge() {
    document.querySelectorAll('#slide-nav-slides .slide-preview[data-steps]')
        .forEach(el => el.removeAttribute('data-steps'));
    if (!_state || _state.editMode) return;
    const idx = _state.currentSlide;
    const obj = _state.slideStructure[idx];
    const total = stepsOf(cfgOf(obj)).length;
    if (!total) return;
    const preview = document.querySelector(`#slide-nav-slides .slide-nav-item[data-index="${idx}"] .slide-preview`);
    if (preview) preview.dataset.steps = `${shownCount(obj, total)}/${total}`;
}

/* ─── ink under closed boxes ─────────────────────────────────── */
// The annotation canvas sits above the whole slide layer, so a box can't
// out-stack it. Instead the ink is masked out wherever a box is still
// closed, so annotations never show through a hidden region.
// The mask fades with the box (same 280ms), so ink appears and disappears
// together with what's under it rather than popping. Per pane we keep how
// open each box's hole is (0 = ink hidden, 1 = ink shown) and tween it.
const FADE_MS = 280;
const _ink = new Map();   // ann element → { open: Map(boxKey → 0..1), raf }

function maskInk(container, covers, animate) {
    const ann = document.getElementById(container.id === 'pdf-canvas-2' ? 'ann-canvas-2' : 'ann-canvas');
    if (!ann) return;
    let st = _ink.get(ann);
    if (!st) { st = { open: new Map(), raf: 0 }; _ink.set(ann, st); }
    cancelAnimationFrame(st.raf);

    const from = new Map();
    for (const c of covers) {
        const prev = st.open.get(c.key);
        from.set(c.key, animate && prev !== undefined ? prev : (c.open ? 1 : 0));
    }
    const target = new Map(covers.map(c => [c.key, c.open ? 1 : 0]));
    st.open = new Map(from);

    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const t0 = performance.now();
    const frame = (now) => {
        const t = animate ? Math.min(1, (now - t0) / FADE_MS) : 1;
        for (const [k, to] of target) {
            const f = from.get(k);
            st.open.set(k, f + (to - f) * ease(t));
        }
        paintMask(ann, st.open);
        if (t < 1) st.raf = requestAnimationFrame(frame);
    };
    frame(t0);
}

function paintMask(ann, open) {
    const parts = [];
    for (const [key, v] of open) {
        if (v >= 0.999) continue;
        const [x, y, w, h] = key.split(',').map(Number);
        parts.push({ x, y, w, h, v });
    }
    if (!parts.length) {
        for (const p of ['mask', '-webkit-mask']) ann.style.removeProperty(`${p}-image`);
        return;
    }
    // An alpha mask: the whole canvas with each box cut out (even-odd fill),
    // then each hole partly refilled by how open the box is.
    const holes = parts.map(b => `M${b.x} ${b.y}h${b.w}v${b.h}h${-b.w}Z`).join('');
    const refills = parts.filter(b => b.v > 0.001)
        .map(b => `<rect x='${b.x}' y='${b.y}' width='${b.w}' height='${b.h}' fill='black' fill-opacity='${b.v.toFixed(3)}'/>`).join('');
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1' preserveAspectRatio='none'>` +
                `<path fill-rule='evenodd' fill='black' d='M0 0H1V1H0Z${holes}'/>${refills}</svg>`;
    const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    for (const p of ['mask', '-webkit-mask']) {
        ann.style.setProperty(`${p}-image`, url);
        ann.style.setProperty(`${p}-size`, '100% 100%');
        ann.style.setProperty(`${p}-repeat`, 'no-repeat');
    }
}

/* ─── colour under a box ──────────────────────────────────────── */
// Median colour of the slide just outside the box's edges, so a blended
// cover matches whatever background the slide has there. Blank slides (no
// PDF canvas showing) are white.
function sampleColour(container, r) {
    const canvas = container.querySelector(':scope > canvas');
    if (!canvas || canvas.style.visibility === 'hidden' || !canvas.width) return '#ffffff';
    let ctx;
    try { ctx = canvas.getContext('2d', { willReadFrequently: true }); } catch { return '#ffffff'; }
    if (!ctx) return '#ffffff';
    const W = canvas.width, H = canvas.height;
    const x0 = (r.x ?? 0) * W, y0 = (r.y ?? 0) * H;
    const x1 = x0 + (r.width ?? 0.3) * W, y1 = y0 + (r.height ?? 0.2) * H;
    const off = Math.max(2, W * 0.004);
    const pts = [];
    for (let i = 0; i <= 12; i++) {
        const fx = x0 + (x1 - x0) * i / 12, fy = y0 + (y1 - y0) * i / 12;
        pts.push([fx, y0 - off], [fx, y1 + off], [x0 - off, fy], [x1 + off, fy]);
    }
    const rs = [], gs = [], bs = [];
    try {
        for (const [px, py] of pts) {
            const cx = Math.round(Math.max(0, Math.min(W - 1, px)));
            const cy = Math.round(Math.max(0, Math.min(H - 1, py)));
            const d = ctx.getImageData(cx, cy, 1, 1).data;
            if (d[3] < 10) { rs.push(255); gs.push(255); bs.push(255); continue; }
            rs.push(d[0]); gs.push(d[1]); bs.push(d[2]);
        }
    } catch { return '#ffffff'; }
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    return `rgb(${med(rs)}, ${med(gs)}, ${med(bs)})`;
}
