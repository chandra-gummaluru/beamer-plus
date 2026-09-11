/**
 * Beamer+ guided tour.
 *
 * Usage:
 *   import { startTour } from './app/tour.js';
 *   startTour();
 */

const PAD = 8;    // padding added around the spotlight rect
const GAP = 14;   // gap between spotlight edge and popover

/* ── Tour steps ─────────────────────────────────────────────── */
const STEPS = [
    {
        sel:   null,
        place: 'center',
        title: 'Welcome to Beamer+',
        body:  'Beamer+ is an interactive presentation tool that lets you annotate slides, embed live widgets, 3D models, video, and audio, and sync everything to a viewer page in real time.',
    },
    {
        sel:   '#upload-presentation-btn',
        place: 'auto',
        title: 'Loading a presentation',
        body:  'Start here. Load a plain PDF slide deck, or a saved Beamer+ ZIP that already has widgets, annotations, and overlays bundled in.',
    },
    {
        sel:   '#slide-navigator',
        place: 'right',
        title: 'Slide navigator',
        body:  'Thumbnail strip of all your slides. Click any thumbnail to jump directly to it. In edit mode you can drag thumbnails to reorder slides.',
    },
    {
        sel:   '#bookmark-btn',
        place: 'right',
        title: 'Bookmarks',
        body:  'Bookmark the current slide for quick access during a presentation. Bookmarked slides appear as pins at the top of the navigator.',
    },
    {
        sel:   '#split-toggle',
        place: 'right',
        title: 'Split view',
        body:  'Split the stage into two independent panes. Show your notes on one side while the audience slide stays in place on the other, or jump ahead while the current slide stays visible.',
    },
    {
        sel:   '#floating-annotation-toolbar',
        place: 'left',
        title: 'Annotation tools',
        body:  'Draw on slides in real time. Choose from the hand pointer, spotlight, pen, or eraser. Pen strokes are synced live to the viewer page. Undo, redo, or clear all at any time.',
    },
    {
        sel:   '#spotlight-btn',
        place: 'left',
        title: 'Spotlight',
        body:  'Dims everything except a movable circle so your audience focuses exactly where you want. Drag the spotlight around the slide to move it.',
    },
    {
        sel:   '#edit-mode-btn',
        place: 'auto',
        title: 'Edit mode',
        body:  'Opens the editing panel where you can add videos, audio, 3D models, and interactive widgets to any slide. Drag and resize overlays freely.',
    },
    {
        sel:   '#edit-save-btn',
        place: 'auto',
        title: 'Save your work',
        body:  'Download the presentation as a Beamer+ ZIP. This bundles your slides together with all widgets, overlays, and annotations so you can reload it later.',
    },
    {
        sel:   '#bottom-controls',
        place: 'top',
        title: 'Help & settings',
        body:  'One place for everything else: the full usage guide, plus a Settings tab to see your session code, switch the theme, and rebind keyboard shortcuts. You can relaunch this tour from here too.',
    },
];

/* ── State ──────────────────────────────────────────────────── */
let _step  = 0;
let _nodes = null; // { backdrop, spotlight, popover, title, body, count, prev, next }
let _keyFn = null;

/* ── Public API ─────────────────────────────────────────────── */
export async function startTour(loadDemo) {
    if (_nodes) return; // already active
    if (loadDemo) await loadDemo();
    _step = 0;
    _mount();
    _goto(0);
}

export function endTour() {
    if (!_nodes) return;
    document.removeEventListener('keydown', _keyFn, { capture: true });
    _nodes.backdrop.remove();
    _nodes.spotlight.remove();
    _nodes.popover.remove();
    _nodes = null;
    _keyFn = null;
}

/* ── DOM construction ───────────────────────────────────────── */
function _mount() {
    // Backdrop — blocks all pointer events on the page during the tour
    const backdrop = _el('div', 'tour-backdrop');

    // Spotlight — uses box-shadow to dim everything outside the target rect
    const spotlight = _el('div', 'tour-spotlight');

    // Popover card
    const popover = _el('div', 'tour-popover');
    popover.innerHTML = `
        <div class="tour-pop-header">
            <span class="tour-count"></span>
            <button class="tour-skip-btn" aria-label="Skip tour">Skip</button>
        </div>
        <h3 class="tour-title"></h3>
        <p  class="tour-body"></p>
        <div class="tour-nav-row">
            <button class="btn tour-back-btn">Back</button>
            <button class="btn tour-next-btn">Next</button>
        </div>
    `;

    document.body.append(backdrop, spotlight, popover);

    const prev = popover.querySelector('.tour-back-btn');
    const next = popover.querySelector('.tour-next-btn');
    const skip = popover.querySelector('.tour-skip-btn');

    skip.addEventListener('click', endTour);
    prev.addEventListener('click', () => _goto(_step - 1));
    next.addEventListener('click', () => {
        if (_step >= STEPS.length - 1) endTour();
        else _goto(_step + 1);
    });

    _keyFn = (e) => {
        if (e.key === 'ArrowRight' || e.key === 'Enter') {
            e.stopPropagation();
            if (_step >= STEPS.length - 1) endTour();
            else _goto(_step + 1);
        } else if (e.key === 'ArrowLeft') {
            e.stopPropagation();
            _goto(_step - 1);
        } else if (e.key === 'Escape') {
            e.stopPropagation();
            endTour();
        }
    };
    document.addEventListener('keydown', _keyFn, { capture: true });

    _nodes = {
        backdrop, spotlight, popover,
        title:  popover.querySelector('.tour-title'),
        body:   popover.querySelector('.tour-body'),
        count:  popover.querySelector('.tour-count'),
        prev, next,
    };
}

/* ── Step navigation ────────────────────────────────────────── */
function _goto(i) {
    _step = Math.max(0, Math.min(STEPS.length - 1, i));
    const step = STEPS[_step];
    const n    = _nodes;
    const last = _step === STEPS.length - 1;

    // Update text content
    n.count.textContent = `${_step + 1} of ${STEPS.length}`;
    n.title.textContent = step.title;
    n.body.textContent  = step.body;
    n.prev.style.visibility = _step === 0 ? 'hidden' : '';
    n.next.textContent = last ? 'Finish' : 'Next';
    n.next.classList.toggle('tour-next-finish', last);

    // Resolve target element
    const target = step.sel ? document.querySelector(step.sel) : null;

    if (!target || step.place === 'center') {
        // Welcome / no-target: full-screen dim, centered popover
        n.backdrop.style.background = 'oklch(5% 0.01 260 / 0.65)';
        n.spotlight.style.opacity   = '0';
        n.popover.dataset.placement = 'center';
        _centerPopover();
    } else {
        n.backdrop.style.background = 'transparent';
        n.spotlight.style.opacity   = '1';
        const r = target.getBoundingClientRect();
        _positionSpotlight(r);
        // Defer popover positioning one frame so the browser has the latest layout
        requestAnimationFrame(() => _positionPopover(r, step.place));
    }
}

/* ── Spotlight positioning ──────────────────────────────────── */
function _positionSpotlight(r) {
    const s = _nodes.spotlight.style;
    s.left   = `${r.left   - PAD}px`;
    s.top    = `${r.top    - PAD}px`;
    s.width  = `${r.width  + PAD * 2}px`;
    s.height = `${r.height + PAD * 2}px`;
}

/* ── Popover positioning ────────────────────────────────────── */
function _positionPopover(r, placement) {
    const pop = _nodes.popover;
    const pw  = pop.offsetWidth  || 300;
    const ph  = pop.offsetHeight || 200;
    const vw  = window.innerWidth;
    const vh  = window.innerHeight;
    const m   = 10; // min margin from viewport edge

    // Pick best side when 'auto'
    let side = placement;
    if (side === 'auto') {
        const space = {
            right:  vw - r.right,
            left:   r.left,
            bottom: vh - r.bottom,
            top:    r.top,
        };
        side = Object.entries(space).reduce((a, b) => a[1] > b[1] ? a : b)[0];
    }

    let left, top;
    switch (side) {
        case 'right':
            left = r.right + GAP;
            top  = _clamp(r.top + r.height / 2 - ph / 2, m, vh - ph - m);
            break;
        case 'left':
            left = r.left - pw - GAP;
            top  = _clamp(r.top + r.height / 2 - ph / 2, m, vh - ph - m);
            break;
        case 'top':
            left = _clamp(r.left + r.width / 2 - pw / 2, m, vw - pw - m);
            top  = r.top - ph - GAP;
            break;
        default: // bottom
            left = _clamp(r.left + r.width / 2 - pw / 2, m, vw - pw - m);
            top  = r.bottom + GAP;
    }

    pop.dataset.placement = side;
    pop.style.left = `${left}px`;
    pop.style.top  = `${top}px`;
}

function _centerPopover() {
    const pop = _nodes.popover;
    requestAnimationFrame(() => {
        const pw = pop.offsetWidth  || 300;
        const ph = pop.offsetHeight || 200;
        pop.style.left = `${(window.innerWidth  - pw) / 2}px`;
        pop.style.top  = `${(window.innerHeight - ph) / 2}px`;
    });
}

/* ── Helpers ────────────────────────────────────────────────── */
function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function _el(tag, id) {
    const e = document.createElement(tag);
    e.id = id;
    return e;
}
