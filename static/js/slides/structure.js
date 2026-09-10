// Slide structure — labels and blank/view slide insertion & deletion.
// The structure is an array of { type: 'pdf'|'blank'|'view', ... } objects;
// annotations and bookmarks are keyed by position in that array, so every
// insert/delete must shift those maps in lockstep (see shiftSlideData).
import { bus } from '../core/events.js';

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

/* ─── index shifting ──────────────────────────────────────────── */

// Keeps every view slide's left/right pane indices consistent after an insertion (+1)
// or deletion (-1) at position `atIdx`.  Called whenever any slide is added or removed.
export function adjustViewIndices(atIdx, delta) {
    for (const obj of _state.slideStructure) {
        if (obj.type !== 'view') continue;
        if (obj.left  !== undefined && obj.left  >= atIdx) obj.left  += delta;
        if (obj.right !== undefined && obj.right >= atIdx) obj.right += delta;
    }
}

// Shift structure-index-keyed maps (annotations, bookmarks) after an insert (+1) or
// delete (-1) at `atIdx`.  For deletions the entry at the removed index is dropped.
function _shiftIndexedMap(map, atIdx, delta) {
    const out = {};
    for (const [key, val] of Object.entries(map)) {
        const k = parseInt(key, 10);
        if (delta < 0 && k === atIdx) continue;   // deleted slot — discard its data
        out[k >= atIdx ? k + delta : k] = val;
    }
    return out;
}

export function shiftSlideData(atIdx, delta) {
    _state.annotations = _shiftIndexedMap(_state.annotations, atIdx, delta);
    _state.bookmarks   = _shiftIndexedMap(_state.bookmarks,   atIdx, delta);
}

/* ─── blank / view slide management ───────────────────────────── */

function insertBlankAfterCurrent() {
    // On an empty deck (fresh session, nothing uploaded) there is no "current"
    // slide to insert after — the blank becomes slide 0. Otherwise it lands
    // immediately after the slide on stage.
    const ins = _state.slideStructure.length === 0 ? 0 : _state.currentSlide + 1;
    const blankId = `b${Date.now()}`;
    adjustViewIndices(ins, +1);
    shiftSlideData(ins, +1);
    _state.slideStructure.splice(ins, 0, { type: 'blank', blankId, parent: null });
    // Refresh first so totalSlides / the navigator know about the new slide
    // before anything navigates to it.
    bus.emit('nav:refresh');
    bus.emit('slide:goto', ins);
}

function insertViewAfterCurrent() {
    const ins    = _state.currentSlide + 1;
    const viewId = `v${Date.now()}`;

    adjustViewIndices(ins, +1);
    shiftSlideData(ins, +1);

    // Splice first so we can compute post-splice indices correctly.
    _state.slideStructure.splice(ins, 0, { type: 'view', viewId, left: 0, right: 0, ratio: 50 });

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
    _state.slideStructure.splice(del, 1);
    _state.totalSlides = _state.slideStructure.length;
    adjustViewIndices(del, -1);          // fix view slides after deletion
    shiftSlideData(del, -1);             // keep annotations/bookmarks aligned
    // Deleting the only slide leaves an empty deck — clamp to 0 so the next
    // insert lands at the start rather than off the front of the array.
    const next = Math.max(0, Math.min(del, _state.slideStructure.length - 1));
    _state.currentSlide = next;
    bus.emit('nav:refresh');
    bus.emit('slide:goto', next);
}
