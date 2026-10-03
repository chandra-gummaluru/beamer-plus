// Magnifier tool — a round lens that follows the pointer and shows the slide
// under it enlarged. A sibling of the spotlight: same pane detection, same
// "click anywhere to go back to the previous tool", and it also needs widget
// iframes to stop swallowing pointer moves while it's active (main.js shares
// setWidgetInteractivityForSpotlight for that).
//
// The lens is a canvas that redraws every frame from what's already painted
// on the stage: the slide canvas, any image/video overlays, and the ink
// canvas on top — so fresh annotations and playing video stay live inside
// it. Widget iframes can't be drawn into a canvas (the browser won't hand
// their pixels over), so inside the lens a widget shows whatever the slide
// has beneath it.
//
// Scroll while it's active to change the zoom (1.5× – 5×). The zoom level is
// remembered for the session.
import { bus } from '../core/events.js';

const LENS_R   = 120;                 // lens radius, CSS px
const ZOOM_MIN = 1.5, ZOOM_MAX = 5, ZOOM_STEP = 0.25;
const ZOOM_KEY = 'beamer-magnifier-zoom';

let _state   = null;
let _lens    = null;                  // { el, cv, ctx, badge }
let _pos     = null;                  // { pane, x, y } in client px, or null when hidden
let _raf     = 0;
let _badgeTimer = 0;
let _zoom    = (() => {
    try { const z = parseFloat(sessionStorage.getItem(ZOOM_KEY)); if (z >= ZOOM_MIN && z <= ZOOM_MAX) return z; } catch {}
    return 2;
})();

// Last non-magnifier tool, restored when the user clicks to leave the lens.
let _prevTool = 'hand';
bus.on('tool:change', (tool) => {
    if (tool !== 'magnify') _prevTool = tool;
});

const active = () => _state && _state.annotationTool === 'magnify';

export function initMagnifier(state) {
    _state = state;

    document.addEventListener('pointermove', (event) => {
        if (!active()) return;
        const pane = paneAt(event.clientX, event.clientY);
        if (!pane) { hideMagnifier(); return; }
        _pos = { pane, x: event.clientX, y: event.clientY };
        showLens();
    }, true);

    document.addEventListener('pointerleave', () => { if (active()) hideMagnifier(); });

    // Scroll to zoom. Only swallowed over a slide, so the navigator's own
    // wheel scrolling keeps working.
    document.addEventListener('wheel', (event) => {
        if (!active() || !paneAt(event.clientX, event.clientY)) return;
        event.preventDefault();
        const dir = event.deltaY < 0 ? 1 : -1;
        setZoom(_zoom + dir * ZOOM_STEP);
    }, { capture: true, passive: false });

    document.addEventListener('click', (event) => {
        if (!active()) return;
        // Clicks on the toolbar itself are tool picks, not "I'm done".
        if (event.target.closest?.('#floating-annotation-toolbar')) return;
        const prev = _prevTool || 'hand';
        const btn = document.querySelector(`#tool-container .tool-btn[data-tool="${prev}"]`);
        document.querySelectorAll('#tool-container .btn').forEach(b => b.classList.remove('btn_selected'));
        if (btn) btn.classList.add('btn_selected');
        bus.emit('tool:change', prev);
    }, true);
}

function setZoom(z) {
    _zoom = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)) * 100) / 100;
    try { sessionStorage.setItem(ZOOM_KEY, String(_zoom)); } catch {}
    if (_lens) {
        _lens.badge.textContent = `${_zoom}×`;
        _lens.badge.classList.add('visible');
        clearTimeout(_badgeTimer);
        _badgeTimer = setTimeout(() => _lens?.badge.classList.remove('visible'), 900);
    }
}

// Which slide the point is over: the right pane in split view, else the left.
function paneAt(x, y) {
    const inside = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    if (_state.splitView && inside(document.getElementById('pdf-canvas-2'))) return 'right';
    if (inside(document.getElementById('pdf-canvas'))) return 'left';
    return null;
}

function ensureLens() {
    if (_lens) return _lens;
    const el = document.createElement('div');
    el.className = 'magnifier-lens';
    el.setAttribute('aria-hidden', 'true');
    const cv = document.createElement('canvas');
    const badge = document.createElement('span');
    badge.className = 'magnifier-zoom';
    el.append(cv, badge);
    // Lives on <body> with position:fixed, so it can hang past a pane's edge
    // instead of being clipped by it.
    document.body.appendChild(el);
    _lens = { el, cv, ctx: cv.getContext('2d'), badge };
    return _lens;
}

function showLens() {
    const lens = ensureLens();
    lens.el.classList.add('visible');
    document.body.classList.add('magnify-lens-on');
    if (!_raf) _raf = requestAnimationFrame(frame);
}

export function hideMagnifier() {
    _pos = null;
    if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
    _lens?.el.classList.remove('visible');
    document.body.classList.remove('magnify-lens-on');
}

// Every frame while visible, so ink being drawn by a co-presenter, a playing
// video or a slide that just finished rendering all show up in the lens.
function frame() {
    _raf = 0;
    if (!_pos || !active()) { hideMagnifier(); return; }
    paint();
    _raf = requestAnimationFrame(frame);
}

function paint() {
    const { el, cv, ctx } = _lens;
    const d   = LENS_R * 2;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(d * dpr)) {
        cv.width = cv.height = Math.round(d * dpr);
        cv.style.width = cv.style.height = d + 'px';
    }
    el.style.transform = `translate(${_pos.x - LENS_R}px, ${_pos.y - LENS_R}px)`;

    const right = _pos.pane === 'right';
    const slideHost = document.getElementById(right ? 'pdf-canvas-2' : 'pdf-canvas');
    const inkHost   = document.getElementById(right ? 'ann-canvas-2' : 'ann-canvas');
    const pane      = document.getElementById(right ? 'pdf-container-2' : 'pdf-container');

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    // Paper first: outside the slide, and anywhere it's transparent.
    ctx.fillStyle = getComputedStyle(slideHost).backgroundColor;
    if (!ctx.fillStyle || ctx.fillStyle === 'rgba(0, 0, 0, 0)') ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);

    // Client coordinates → lens pixels: centre on the pointer, then scale.
    ctx.setTransform(dpr * _zoom, 0, 0, dpr * _zoom,
                     dpr * (LENS_R - _pos.x * _zoom), dpr * (LENS_R - _pos.y * _zoom));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const draw = (src) => {
        const r = src.getBoundingClientRect();
        if (!r.width || !r.height) return;
        if (src.tagName === 'VIDEO' && src.readyState < 2) return;
        if (src.tagName === 'IMG' && !src.complete) return;
        if (getComputedStyle(src).visibility === 'hidden') return;
        try { ctx.drawImage(src, r.left, r.top, r.width, r.height); }
        catch (_) { /* a cross-origin image or video taints nothing, it just can't be drawn */ }
    };

    slideHost?.querySelectorAll('canvas').forEach(draw);
    pane?.querySelectorAll('img, video').forEach(el => {
        if (!el.closest('#ann-canvas, #ann-canvas-2, .magnifier-lens')) draw(el);
    });
    inkHost?.querySelectorAll('canvas').forEach(draw);
}
