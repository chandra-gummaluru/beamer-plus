// Slide reordering — drag thumbnails in the navigator while in edit mode.
//
// Built on pointer events rather than native HTML5 drag & drop, which gave
// almost no feedback (a 3px edge on whichever thumbnail was hovered, nothing
// at all over the gaps between them), didn't auto-scroll, and doesn't work
// with touch or a pen. Here:
//
//   · a press becomes a drag once it moves a few pixels (mouse/pen) or after
//     a short hold (touch — so a plain swipe still scrolls the list); a press
//     that never becomes a drag is an ordinary click
//   · a ghost of the thumbnail follows the pointer, the other thumbnails
//     slide apart to show the new order live, and the slot the slide will
//     land in is outlined
//   · the list auto-scrolls when the pointer nears either end
//   · Esc, or letting go well away from the list, cancels
//
// The drop itself goes through reorderSlide, which remaps every
// structure-index-keyed piece of state through the same old→new permutation
// (see remapSlideIndices).
import { bus } from '../core/events.js';
import { ctx } from './context.js';
import { remapSlideIndices } from '../slides/structure.js';

const DRAG_SLOP     = 6;     // px a mouse/pen press must travel to become a drag
const TOUCH_HOLD_MS = 280;   // hold before a touch press becomes a drag
const TOUCH_SLOP    = 10;    // …and moving further than this first means "scroll"
const EDGE          = 32;    // px from the list's ends where auto-scroll kicks in
const EDGE_DELAY_MS = 220;   // …after resting there this long, so dropping next
                             // to the last visible slide doesn't scroll past it
const MAX_SCROLL    = 14;    // px per frame at the very edge
const CANCEL_DIST   = 140;   // px off the list (across it) that means "cancel"

let _host  = null;           // #slide-nav-slides while reordering is enabled
let _press = null;           // a press that may yet become a drag
let _drag  = null;           // the drag in progress

const _items = () => Array.from(_host?.querySelectorAll(':scope > .slide-nav-item') || []);
const _isHorizontal = () => getComputedStyle(_host).flexDirection.startsWith('row');

export function applySlideReorder() {
    removeSlideReorder();
    // Scoped to #slide-nav-slides: bookmark pins share the `.slide-nav-item`
    // class but live in #bookmark-pins and aren't part of the slide structure.
    // Delegated, so it keeps working as the navigator re-renders its items.
    _host = document.getElementById('slide-nav-slides');
    _host?.addEventListener('pointerdown', _onPointerDown);
    // Thumbnails are <img>s, which the browser would start dragging natively
    // — and that cancels the pointer stream mid-gesture.
    _host?.addEventListener('dragstart', _preventNativeDrag);
}

function _preventNativeDrag(e) { e.preventDefault(); }

export function removeSlideReorder() {
    _cancelPress();
    _endDrag(false);
    _host?.removeEventListener('pointerdown', _onPointerDown);
    _host?.removeEventListener('dragstart', _preventNativeDrag);
    _host = null;
}

/* ─── press → drag ─────────────────────────────────────────────── */

function _onPointerDown(e) {
    if (_drag || _press) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const item = e.target.closest?.('.slide-nav-item');
    if (!item || item.parentElement !== _host) return;
    const from = _items().indexOf(item);
    if (from < 0) return;

    _press = { item, from, id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, timer: null };
    if (e.pointerType === 'touch') {
        _press.timer = setTimeout(() => { if (_press) _startDrag(_press.x, _press.y); }, TOUCH_HOLD_MS);
    }
    window.addEventListener('pointermove',   _onPointerMove);
    window.addEventListener('pointerup',     _onPointerUp);
    window.addEventListener('pointercancel', _onPointerCancel);
}

function _cancelPress() {
    if (_press?.timer) clearTimeout(_press.timer);
    _press = null;
    if (!_drag) _unlistenPointer();
}

function _unlistenPointer() {
    window.removeEventListener('pointermove',   _onPointerMove);
    window.removeEventListener('pointerup',     _onPointerUp);
    window.removeEventListener('pointercancel', _onPointerCancel);
}

function _onPointerMove(e) {
    if (_press && e.pointerId === _press.id && !_drag) {
        const moved = Math.hypot(e.clientX - _press.x, e.clientY - _press.y);
        if (_press.type === 'touch') {
            // Moved before the hold completed: the user is scrolling the list.
            if (moved > TOUCH_SLOP) _cancelPress();
            else { _press.x = e.clientX; _press.y = e.clientY; }
            return;
        }
        if (moved > DRAG_SLOP) _startDrag(e.clientX, e.clientY);
        else return;
    }
    if (_drag && e.pointerId === _drag.id) {
        _drag.px = e.clientX; _drag.py = e.clientY;
        _moveGhost();
        _updateTarget();
    }
}

function _onPointerUp(e) {
    if (_drag && e.pointerId === _drag.id) { _endDrag(true); return; }
    if (_press && e.pointerId === _press.id) _cancelPress();   // plain click — let it through
}

function _onPointerCancel(e) {
    if (_drag && e.pointerId === _drag.id) _endDrag(false);
    else if (_press && e.pointerId === _press.id) _cancelPress();
}

/* ─── the drag ─────────────────────────────────────────────────── */

function _startDrag(px, py) {
    const { item, from, id } = _press;
    if (_press.timer) clearTimeout(_press.timer);
    _press = null;
    if (!item.isConnected) { _unlistenPointer(); return; }

    const horiz = _isHorizontal();
    const items = _items();
    const hostRect = _host.getBoundingClientRect();
    const scroll0  = horiz ? _host.scrollLeft : _host.scrollTop;
    // Each thumbnail's start and size along the list, in the list's own
    // scroll space, captured before anything moves.
    const slots = items.map(el => {
        const r = el.getBoundingClientRect();
        return horiz
            ? { start: r.left - hostRect.left + scroll0, size: r.width }
            : { start: r.top  - hostRect.top  + scroll0, size: r.height };
    });

    const r = item.getBoundingClientRect();
    const ghost = item.cloneNode(true);
    ghost.classList.remove('active', 'current-slide', 'is-drag-source');
    ghost.classList.add('slide-nav-ghost');
    Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px` });
    document.body.appendChild(ghost);

    _drag = {
        id, from, items, slots, horiz, ghost,
        target: from,               // where the slide would land (0‥n-1)
        offX: px - r.left, offY: py - r.top,
        px, py, raf: 0,
    };
    item.classList.add('is-drag-source');
    document.body.classList.add('nav-reordering');
    // Touch: once the drag has started, stop the same gesture from also
    // scrolling the list (or the page) underneath it.
    window.addEventListener('touchmove', _blockTouchScroll, { passive: false });
    window.addEventListener('keydown', _onKeyDown, true);
    _moveGhost();
    _updateTarget();
    _drag.raf = requestAnimationFrame(_autoScroll);
}

function _blockTouchScroll(e) { if (_drag) e.preventDefault(); }

function _onKeyDown(e) {
    if (!_drag || e.key !== 'Escape') return;
    e.preventDefault(); e.stopImmediatePropagation();
    _endDrag(false);
}

function _moveGhost() {
    const d = _drag;
    d.ghost.style.left = `${d.px - d.offX}px`;
    d.ghost.style.top  = `${d.py - d.offY}px`;
}

// Where along the list the pointer is, in the same scroll space as `slots`.
function _pointerPos() {
    const d = _drag, hr = _host.getBoundingClientRect();
    return d.horiz ? d.px - hr.left + _host.scrollLeft
                   : d.py - hr.top  + _host.scrollTop;
}

// Pointer far off to the side of the list: treat a drop there as "never mind".
function _pointerAway() {
    const d = _drag, hr = _host.getBoundingClientRect();
    return d.horiz ? (d.py < hr.top - CANCEL_DIST || d.py > hr.bottom + CANCEL_DIST)
                   : (d.px < hr.left - CANCEL_DIST || d.px > hr.right + CANCEL_DIST);
}

function _updateTarget() {
    const d = _drag;
    let target = d.from;
    if (!_pointerAway()) {
        // The dragged slide lands after every other slide whose midpoint the
        // pointer has passed.
        const pos = _pointerPos();
        target = 0;
        d.slots.forEach((s, k) => { if (k !== d.from && pos > s.start + s.size / 2) target++; });
    }
    d.away = _pointerAway();
    d.ghost.classList.toggle('is-away', d.away);
    if (target === d.target && d.laidOut) return;
    d.target = target; d.laidOut = true;

    // Lay the thumbnails out in the order they'd end up in: every slide
    // slides into the slot it will occupy, and the dragged one's own slot
    // (shown as an outlined placeholder) moves to where it will land.
    const order = d.items.map((_, k) => k).filter(k => k !== d.from);
    order.splice(target, 0, d.from);
    order.forEach((k, pos) => {
        const shift = d.slots[pos].start - d.slots[k].start;
        d.items[k].style.transform = shift
            ? (d.horiz ? `translateX(${shift}px)` : `translateY(${shift}px)`)
            : '';
    });
}

function _autoScroll() {
    const d = _drag;
    if (!d) return;
    const hr = _host.getBoundingClientRect();
    const [p, lo, hi] = d.horiz ? [d.px, hr.left, hr.right] : [d.py, hr.top, hr.bottom];
    let v = 0;
    if (p < lo + EDGE)      v = -MAX_SCROLL * Math.min(1, (lo + EDGE - p) / EDGE);
    else if (p > hi - EDGE) v =  MAX_SCROLL * Math.min(1, (p - (hi - EDGE)) / EDGE);
    if (!v || _pointerAway()) d.edgeSince = 0;
    else if (!d.edgeSince)    d.edgeSince = performance.now();
    if (d.edgeSince && performance.now() - d.edgeSince > EDGE_DELAY_MS) {
        if (d.horiz) _host.scrollLeft += v; else _host.scrollTop += v;
        _updateTarget();
    }
    d.raf = requestAnimationFrame(_autoScroll);
}

function _endDrag(commit) {
    const d = _drag;
    if (!d) return;
    _drag = null;
    cancelAnimationFrame(d.raf);
    window.removeEventListener('touchmove', _blockTouchScroll);
    window.removeEventListener('keydown', _onKeyDown, true);
    _unlistenPointer();
    d.ghost.remove();
    document.body.classList.remove('nav-reordering');
    d.items.forEach(el => { el.style.transform = ''; el.classList.remove('is-drag-source'); });

    // The pointerup that ends a drag is followed by a click on whatever is
    // under it — which would navigate to that slide. Swallow that one click.
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);

    if (!commit || d.away || d.target === d.from) return;
    // reorderSlide takes "insert before this original index".
    reorderSlide(d.from, d.target < d.from ? d.target : d.target + 1);
}

function reorderSlide(fromIndex, insertBefore) {
    if (fromIndex === insertBefore || fromIndex === insertBefore - 1) return;
    const struct   = ctx.state.slideStructure;
    const n        = struct.length;
    if (fromIndex < 0 || fromIndex >= n) return;

    const [moved] = struct.splice(fromIndex, 1);
    const actualInsert = fromIndex < insertBefore ? insertBefore - 1 : insertBefore;
    struct.splice(actualInsert, 0, moved);

    const oldToNew = new Array(n);
    for (let i = 0; i < n; i++) {
        if (i === fromIndex)                                                  oldToNew[i] = actualInsert;
        else if (fromIndex < insertBefore && i > fromIndex && i < insertBefore) oldToNew[i] = i - 1;
        else if (fromIndex >= insertBefore && i >= insertBefore && i < fromIndex) oldToNew[i] = i + 1;
        else                                                                  oldToNew[i] = i;
    }

    // Annotations, bookmarks, text boxes, view panes, the current slide, the
    // right pane and the active view all move together. (Previously only the
    // first four did, so a reorder with a split open left the right pane —
    // and the annotations saved from it — pointing at the wrong slide.)
    remapSlideIndices(i => oldToNew[i] ?? null);
    bus.emit('slides:reordered');
}
