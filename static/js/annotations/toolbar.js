// Annotation toolbar — owns tool selection (pen/eraser/laser/shape/select).
import { bus } from '../core/events.js';

export function initToolbar(state) {
    const tools = document.querySelectorAll('#tool-container .tool-btn');
    tools.forEach(btn => {
        btn.addEventListener('click', () => {
            // Clear selection across the whole rail, not just the buttons this
            // module queried at init — pen slots are added afterwards (by
            // initPenSlots) and have their own 'btn_selected' class to clear too.
            document.querySelectorAll('#tool-container .btn').forEach(b => b.classList.remove('btn_selected'));
            btn.classList.add('btn_selected');
            state.annotationTool = btn.dataset.tool;
            const shapeSidebar = document.getElementById('shape-sidebar');
            if (shapeSidebar) shapeSidebar.style.display =
                btn.dataset.tool === 'shape' ? 'flex' : 'none';
            // Note: the text-size sidebar is deliberately NOT shown here —
            // it only appears once a textbox is actually open (see
            // main.js's textbox:opened/closed listeners), not just because
            // the Text tool got selected.
            bus.emit('tool:change', btn.dataset.tool);
        });
    });
    // Note: undo / redo / clear buttons are wired directly to the canvas in
    // main.js (wireUndoRedo / wireAnnotationClear), so they're not handled here.
}

/* ─── draggable toolbar ─────────────────────────────────────────── */
// The grip at the head of the toolbar lets the presenter move the rail out of
// the way of slide content. Double-click the grip (or press Home while it has
// focus) to snap it back to its default spot.
//
// The toolbar has two shapes — a vertical right-hand rail, and a horizontal bar
// in split view / on narrow screens — so a position is remembered separately
// for each. Positions are stored as fractions of the free space
// (viewport − toolbar), so a toolbar parked against an edge stays against it
// when the window resizes.
//
// While moved, the toolbar's rect is published as CSS variables on <body>
// (--ann-tb-left/right/top/bottom/cx/cy) together with the class
// .ann-toolbar-moved, and annotations.css hangs the text-size flyout off those
// instead of its fixed default spot. .ann-toolbar-flip says the flyout should
// open on the other side because the toolbar is too close to the edge.
const POS_KEY = 'beamer-toolbar-pos';
const EDGE = 8;              // keep this many px between toolbar and viewport edge
const FLYOUT_ROOM = 120;     // px the flyout needs beside/below the toolbar
const NUDGE = 16;            // arrow-key step (px); Shift = ×4

function loadPositions() {
    try { return JSON.parse(localStorage.getItem(POS_KEY) || 'null') || {}; } catch { return {}; }
}
function savePositions(p) {
    try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch {}
}

export function initToolbarDrag() {
    const bar  = document.getElementById('floating-annotation-toolbar');
    const grip = document.getElementById('annotation-toolbar-grip');
    if (!bar || !grip) return;

    const narrowMq = window.matchMedia('(max-width: 1024px)');
    const layout = () =>
        (document.body.classList.contains('split-view-active') || narrowMq.matches)
            ? 'horizontal' : 'vertical';

    let positions = loadPositions();
    let current = null;          // {x, y} fractions for the active layout, or null
    let lastLayout = layout();

    const clampPx = (left, top) => {
        const r = bar.getBoundingClientRect();
        const maxL = Math.max(EDGE, window.innerWidth  - r.width  - EDGE);
        const maxT = Math.max(EDGE, window.innerHeight - r.height - EDGE);
        return {
            left: Math.min(Math.max(left, EDGE), maxL),
            top:  Math.min(Math.max(top,  EDGE), maxT),
            maxL, maxT,
        };
    };

    // Only touch <body>'s class list when something actually changes: the
    // MutationObserver below watches it, and classList.add/remove record a
    // mutation even when the class was already (or never) there.
    const setBodyClass = (name, on) => {
        if (document.body.classList.contains(name) !== on) document.body.classList.toggle(name, on);
    };

    const publishRect = () => {
        const body = document.body;
        if (!current) {
            setBodyClass('ann-toolbar-moved', false);
            setBodyClass('ann-toolbar-flip', false);
            return;
        }
        const r = bar.getBoundingClientRect();
        const s = body.style;
        s.setProperty('--ann-tb-left',   `${r.left}px`);
        s.setProperty('--ann-tb-right',  `${r.right}px`);
        s.setProperty('--ann-tb-top',    `${r.top}px`);
        s.setProperty('--ann-tb-bottom', `${r.bottom}px`);
        s.setProperty('--ann-tb-cx',     `${r.left + r.width / 2}px`);
        s.setProperty('--ann-tb-cy',     `${r.top + r.height / 2}px`);
        const flip = layout() === 'vertical'
            ? r.left < FLYOUT_ROOM                               // no room on the left → open right
            : r.bottom > window.innerHeight - FLYOUT_ROOM;       // no room below → open above
        setBodyClass('ann-toolbar-moved', true);
        setBodyClass('ann-toolbar-flip', flip);
    };

    const clearInline = () => {
        ['left', 'top', 'right', 'bottom', 'transform'].forEach(p => bar.style.removeProperty(p));
    };

    // Put the toolbar at pixel (left, top), clamped; returns the fractions used.
    const placePx = (left, top) => {
        bar.style.right = 'auto';
        bar.style.bottom = 'auto';
        bar.style.transform = 'none';
        const c = clampPx(left, top);
        bar.style.left = `${c.left}px`;
        bar.style.top  = `${c.top}px`;
        const fx = c.maxL > EDGE ? (c.left - EDGE) / (c.maxL - EDGE) : 0;
        const fy = c.maxT > EDGE ? (c.top  - EDGE) / (c.maxT - EDGE) : 0;
        return { x: fx, y: fy };
    };

    // Re-apply the stored position for the current layout (or the CSS default).
    const apply = () => {
        const saved = positions[layout()];
        if (!saved) {
            current = null;
            clearInline();
        } else {
            // Size is layout-dependent, so measure with the inline position
            // cleared of any stale clamping first, then convert fractions → px.
            bar.style.right = 'auto';
            bar.style.bottom = 'auto';
            bar.style.transform = 'none';
            const { maxL, maxT } = clampPx(0, 0);
            placePx(EDGE + saved.x * (maxL - EDGE), EDGE + saved.y * (maxT - EDGE));
            current = saved;
        }
        publishRect();
    };

    const commit = (frac) => {
        current = frac;
        positions[layout()] = frac;
        savePositions(positions);
        publishRect();
    };

    const reset = () => {
        delete positions[layout()];
        savePositions(positions);
        apply();
    };

    /* pointer drag */
    let drag = null;
    grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const r = bar.getBoundingClientRect();
        drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, frac: null };
        grip.setPointerCapture(e.pointerId);
        bar.classList.add('is-dragging');
    });
    grip.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        drag.frac = placePx(e.clientX - drag.dx, e.clientY - drag.dy);
        current = drag.frac;
        publishRect();
    });
    const endDrag = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        if (drag.frac) commit(drag.frac);
        drag = null;
        bar.classList.remove('is-dragging');
        if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    };
    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', endDrag);
    grip.addEventListener('dblclick', reset);

    /* keyboard: arrows nudge, Home resets */
    grip.addEventListener('keydown', (e) => {
        if (e.key === 'Home') { e.preventDefault(); reset(); return; }
        const step = e.shiftKey ? NUDGE * 4 : NUDGE;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();     // don't also change slides
        const r = bar.getBoundingClientRect();
        commit(placePx(r.left + d[0], r.top + d[1]));
    });

    /* keep it on-screen and in sync with layout changes */
    const relayout = () => {
        const l = layout();
        if (l !== lastLayout) { lastLayout = l; apply(); return; }
        if (current && !drag) apply(); else publishRect();
    };
    window.addEventListener('resize', relayout);
    narrowMq.addEventListener?.('change', relayout);
    new MutationObserver(relayout).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // Pen slots are added after init, and the bar changes size between layouts.
    if ('ResizeObserver' in window) new ResizeObserver(() => { if (!drag) relayout(); }).observe(bar);

    apply();
}
