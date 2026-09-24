// Slide structure — labels and blank/view slide insertion & deletion.
// The structure is an array of { type: 'pdf'|'blank'|'view', ... } objects.
// A lot of state refers to slides by their position in that array
// (annotations, bookmarks, text boxes, view panes, the current and right-pane
// slide…), so every insert, delete and reorder goes through
// remapSlideIndices, which moves all of it in one place.
import { bus } from '../core/events.js';
import { discardParkedWidgets } from '../core/iframe-widget-renderer.js';

let _state = null;

export function initSlideStructure(state) {
    _state = state;
    document.getElementById('add-blank-btn')?.addEventListener('click', () => insertBlankAfterCurrent());
    document.getElementById('add-view-btn')?.addEventListener('click',  () => insertViewAfterCurrent());
    document.getElementById('delete-blank-btn')?.addEventListener('click', () => deleteCurrentBlank());
}

/* ─── labels ──────────────────────────────────────────────────── */
// "1", "2", … for PDF slides; "7a", "7b", … for blanks/views after slide 7.
export function getSlideLabels(structure) {
    const labels = [];
    let pdfCount = 0;
    let blankCount = 0;
    for (const obj of structure) {
        if (obj.type !== 'blank' && obj.type !== 'view') {
            pdfCount++;
            blankCount = 0;
            labels.push(String(pdfCount));
        } else {
            blankCount++;
            const suffix = blankCount <= 26
                ? String.fromCharCode(96 + blankCount)
                : String(blankCount);
            labels.push(`${pdfCount}${suffix}`);
        }
    }
    return labels;
}

/* ─── slide identity ──────────────────────────────────────────── */
// A key that stays with a slide wherever it moves in the deck. Positions
// change on every insert/delete/reorder; this doesn't. Widget iframes are
// tagged with it, so a slide's live widgets follow the slide instead of
// staying behind at its old position (and being handed to — or destroyed
// by — whichever slide lands there next).
//
// Held in a WeakMap on the structure object itself rather than derived from
// pdfIndex/blankId, so it works for every slide type and for older decks
// whose blanks carry no id. It lasts for the session; loading a deck builds
// new objects and so new keys (and discards every old widget anyway).
const _slideUids = new WeakMap();
let _nextSlideUid = 1;
export function slideUid(obj) {
    if (!obj || typeof obj !== 'object') return null;
    let uid = _slideUids.get(obj);
    if (!uid) { uid = 's' + (_nextSlideUid++); _slideUids.set(obj, uid); }
    return uid;
}

/* ─── index remapping ─────────────────────────────────────────── */
// The one place that moves position-keyed state after the structure array
// has changed. Call it *after* splicing the array, with `oldToNew(i)` giving
// slide i's new position, or null if slide i was removed.
//
//   · keyed data (annotations, bookmarks, text boxes) follows its slide, and
//     is dropped with it if the slide was removed
//   · pointers (view panes, current slide, right pane) follow their slide;
//     one that pointed at a removed slide falls back to whatever now sits in
//     that position, clamped to the deck
//   · the active view index follows its view, or clears if it was removed
//
// Editor-side state (the view slide being configured) listens for
// 'slides:remapped' and follows the same mapping.
export function remapSlideIndices(oldToNew) {
    const s = _state;
    const n = s.slideStructure.length;
    const moveKeys = (map) => {
        const out = {};
        for (const [key, val] of Object.entries(map || {})) {
            const j = oldToNew(parseInt(key, 10));
            if (j != null) out[j] = val;
        }
        return out;
    };
    const movePtr = (i) => {
        if (i == null) return i;
        const j = oldToNew(i);
        return j != null ? j : Math.max(0, Math.min(i, n - 1));
    };

    s.annotations = moveKeys(s.annotations);
    s.bookmarks   = moveKeys(s.bookmarks);
    if (s.textBoxes) s.textBoxes = moveKeys(s.textBoxes);

    for (const obj of s.slideStructure) {
        if (obj.type !== 'view') continue;
        if (obj.left  !== undefined) obj.left  = movePtr(obj.left);
        if (obj.right !== undefined) obj.right = movePtr(obj.right);
    }
    s.currentSlide    = movePtr(s.currentSlide);
    s.rightSlideIndex = movePtr(s.rightSlideIndex);
    if (s.currentViewIndex != null) s.currentViewIndex = oldToNew(s.currentViewIndex);
    s.totalSlides = n;

    bus.emit('slides:remapped', oldToNew);
}

const shiftedFrom = (atIdx) => (i) => (i >= atIdx ? i + 1 : i);
const removedAt   = (atIdx) => (i) => (i === atIdx ? null : i > atIdx ? i - 1 : i);

// Delete the slide at `idx`, taking its position-keyed data and its live
// widgets with it. Used for blanks here and for view slides by the editor.
export function removeSlideAt(idx) {
    const [gone] = _state.slideStructure.splice(idx, 1);
    if (!gone) return;
    // Its widgets were parked under the slide's own key and nothing will
    // ever show that slide again — shut them down rather than leaving
    // hidden iframes (and their sockets and timers) running.
    const uid = slideUid(gone);
    discardParkedWidgets('L:' + uid);
    discardParkedWidgets('R:' + uid);
    remapSlideIndices(removedAt(idx));
}

/* ─── blank / view slide management ───────────────────────────── */

function insertBlankAfterCurrent() {
    // On an empty deck (fresh session, nothing uploaded) there is no "current"
    // slide to insert after — the blank becomes slide 0. Otherwise it lands
    // immediately after the slide on stage.
    const ins = _state.slideStructure.length === 0 ? 0 : _state.currentSlide + 1;
    const blankId = `b${Date.now()}`;
    _state.slideStructure.splice(ins, 0, { type: 'blank', blankId, parent: null });
    remapSlideIndices(shiftedFrom(ins));
    // Refresh first so totalSlides / the navigator know about the new slide
    // before anything navigates to it.
    bus.emit('nav:refresh');
    bus.emit('slide:goto', ins);
}

function insertViewAfterCurrent() {
    const ins    = _state.currentSlide + 1;
    const viewId = `v${Date.now()}`;

    // Splice first so we can compute post-splice indices correctly. The new
    // view has no panes yet, so the remap leaves it alone.
    _state.slideStructure.splice(ins, 0, { type: 'view', viewId, ratio: 50 });
    remapSlideIndices(shiftedFrom(ins));

    // Left pane: current slide (unchanged after splice).
    // Right pane: the slide immediately after the view slide (ins+1), i.e. the
    // old "next slide" which is now labelled e.g. 7b after the view slide 7a.
    const leftDef  = _state.currentSlide;
    const len      = _state.slideStructure.length;
    const rightDef = ins + 1 < len ? ins + 1
                   : Math.max(0, leftDef - 1);

    _state.slideStructure[ins].left  = leftDef;
    _state.slideStructure[ins].right = rightDef;

    bus.emit('nav:refresh');
    if (_state.editMode) bus.emit('view:select', ins);
}

function deleteCurrentBlank() {
    const obj = _state.slideStructure[_state.currentSlide];
    if (obj?.type !== 'blank') return;
    const del = _state.currentSlide;
    removeSlideAt(del);
    // Deleting the only slide leaves an empty deck — clamp to 0 so the next
    // insert lands at the start rather than off the front of the array.
    const next = Math.max(0, Math.min(del, _state.slideStructure.length - 1));
    _state.currentSlide = next;
    bus.emit('nav:refresh');
    bus.emit('slide:goto', next);
}
