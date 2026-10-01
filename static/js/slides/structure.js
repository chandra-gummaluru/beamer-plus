// Slide structure — labels and blank/view slide insertion & deletion.
// The structure is an array of { type: 'pdf'|'blank'|'view', ... } objects.
// A lot of state refers to slides by their position in that array
// (annotations, bookmarks, text boxes, view panes, the current and right-pane
// slide…), so every insert, delete and reorder goes through
// remapSlideIndices, which moves all of it in one place.
import { bus } from '../core/events.js';
import { discardParkedWidgets, requestWidgetStates, seedWidgetStates } from '../core/iframe-widget-renderer.js';
import { PAPER_STYLES, PAPER_SPACING, PAPER_THICKNESS, PAPER_COLORS, normalizePaper, applyPaper } from './paper.js';

let _state = null;

export function initSlideStructure(state) {
    _state = state;
    document.getElementById('add-blank-btn')?.addEventListener('click', () => openAddPageModal());
    document.getElementById('duplicate-slide-btn')?.addEventListener('click', () => duplicateCurrentSlide());
    document.getElementById('add-view-btn')?.addEventListener('click',  () => insertViewAfterCurrent());
    document.getElementById('delete-blank-btn')?.addEventListener('click', () => deleteCurrentBlank());
    bus.on('slide:delete', (i) => deleteSlideAt(i));
}

/* ─── labels ──────────────────────────────────────────────────── */
// "1", "2", … for PDF slides; "7a", "7b", … for blanks/views after slide 7.
export function getSlideLabels(structure) {
    const labels = [];
    let pdfCount = 0;
    let blankCount = 0;
    for (const obj of structure) {
        // A duplicated PDF page (it carries its own cfgId) is labelled like a
        // blank — "7a" — so copying a slide doesn't renumber the rest of the deck.
        if (obj.type !== 'blank' && obj.type !== 'view' && !obj.cfgId) {
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

/* ─── real slides ─────────────────────────────────────────────── */
// Slides with content of their own — PDF pages and blanks, not view (split)
// slides, which only point at two others. Split view needs two of them.
export function realSlideCount(structure) {
    return (structure || []).filter(o => o && o.type !== 'view').length;
}

/* ─── config key ──────────────────────────────────────────────── */
// Which slideConfigs entry (and config/s<key>.json) holds a slide's media and
// widgets. PDF pages use their pdfIndex — except a duplicated page, which
// shows the same PDF page but owns its own config under `cfgId`. Blanks use
// their blankId. View slides have no config of their own.
export function configKeyOf(obj) {
    if (!obj) return null;
    if (obj.cfgId) return obj.cfgId;
    if (obj.type === 'pdf') return obj.pdfIndex;
    if (obj.type === 'blank') return obj.blankId ?? null;
    return null;
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

/* ─── add page (with a style) ─────────────────────────────────── */
// The add button opens a small chooser: Plain, Lined, Grid or Dots, plus
// spacing / weight / colour for the patterned ones, previewed live. The last
// choice is remembered for the session, so adding several pages of the same
// paper is one click each.
let _lastPaper = { style: 'none' };

function openAddPageModal() {
    const choice = normalizePaper(_lastPaper);
    const root = document.createElement('div');
    root.className = 'add-page';

    const grid = document.createElement('div');
    grid.className = 'add-page-styles';
    root.appendChild(grid);

    const opts = document.createElement('div');
    opts.className = 'add-page-opts';
    root.appendChild(opts);

    const cards = PAPER_STYLES.map(st => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'add-page-card';
        card.innerHTML = '<span class="add-page-sheet"></span><span class="add-page-name"></span>';
        card.querySelector('.add-page-name').textContent = st.l;
        card.addEventListener('click', () => { choice.style = st.v; sync(); });
        card.addEventListener('dblclick', () => { choice.style = st.v; add(); window.BeamerModal?.close(); });
        grid.appendChild(card);
        return { st, card, sheet: card.querySelector('.add-page-sheet') };
    });

    const selects = {};
    const field = (key, list, label) => {
        const wrap = document.createElement('label');
        wrap.className = 'add-page-field';
        wrap.innerHTML = '<span class="add-page-label"></span>';
        wrap.querySelector('.add-page-label').textContent = label;
        const sel = document.createElement('select');
        sel.className = 'editor-prop-select';
        sel.innerHTML = list.map(o => `<option value="${o.v}">${o.l}</option>`).join('');
        sel.addEventListener('change', () => { choice[key] = sel.value; sync(); });
        wrap.appendChild(sel);
        opts.appendChild(wrap);
        selects[key] = { sel, wrap };
    };
    field('spacing', PAPER_SPACING, 'Spacing');
    field('thickness', PAPER_THICKNESS, 'Line weight');
    field('color', PAPER_COLORS, 'Colour');

    function sync() {
        for (const { st, card, sheet } of cards) {
            card.classList.toggle('is-active', st.v === choice.style);
            applyPaper(sheet, { ...choice, style: st.v }, { thumb: true });
        }
        for (const [k, { sel }] of Object.entries(selects)) sel.value = choice[k];
        opts.hidden = choice.style === 'none';
        selects.thickness.wrap.querySelector('.add-page-label').textContent =
            choice.style === 'dots' ? 'Dot size' : 'Line weight';
    }
    function add() {
        _lastPaper = { ...choice };
        insertBlankAfterCurrent(choice.style === 'none' ? null : { ...choice });
    }
    sync();

    window.BeamerModal?.show({
        kind: 'info',
        title: 'Add page',
        body: root,
        buttons: [
            { label: 'Cancel', kind: 'cancel' },
            { label: 'Add page', kind: 'ok', onClick: add },
        ],
    });
}

function insertBlankAfterCurrent(paper = null) {
    // On an empty deck (fresh session, nothing uploaded) there is no "current"
    // slide to insert after — the blank becomes slide 0. Otherwise it lands
    // immediately after the slide on stage.
    const ins = _state.slideStructure.length === 0 ? 0 : _state.currentSlide + 1;
    const blankId = `b${Date.now()}`;
    const obj = { type: 'blank', blankId, parent: null };
    if (paper) obj.paper = paper;
    _state.slideStructure.splice(ins, 0, obj);
    remapSlideIndices(shiftedFrom(ins));
    // Refresh first so totalSlides / the navigator know about the new slide
    // before anything navigates to it.
    bus.emit('nav:refresh');
    bus.emit('slide:goto', ins);
}

function insertViewAfterCurrent() {
    if (realSlideCount(_state.slideStructure) < 2) return;   // nothing to pair
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

// Slides the navigator's delete button may remove: blanks, and duplicated
// PDF pages (the original page stays in the deck either way).
export function isDeletableSlide(obj) {
    return obj?.type === 'blank' || (obj?.type === 'pdf' && !!obj.cfgId);
}

// Delete any slide (from the navigator's hover button in edit mode). A PDF
// page removed this way leaves the deck; its page stays in slides.pdf, so
// re-uploading the deck brings it back.
function deleteSlideAt(idx) {
    const s = _state;
    if (!s.editMode || idx < 0 || idx >= s.slideStructure.length) return;
    const wasCurrent = idx === s.currentSlide;
    removeSlideAt(idx);
    const n = s.slideStructure.length;
    s.currentSlide = Math.max(0, Math.min(wasCurrent ? idx : s.currentSlide, n - 1));
    bus.emit('nav:refresh');
    if (n) bus.emit('slide:goto', s.currentSlide);
}

function deleteCurrentBlank() {
    const obj = _state.slideStructure[_state.currentSlide];
    if (!isDeletableSlide(obj)) return;
    const del = _state.currentSlide;
    removeSlideAt(del);
    // Deleting the only slide leaves an empty deck — clamp to 0 so the next
    // insert lands at the start rather than off the front of the array.
    const next = Math.max(0, Math.min(del, _state.slideStructure.length - 1));
    _state.currentSlide = next;
    bus.emit('nav:refresh');
    bus.emit('slide:goto', next);
}

/* ─── duplicate ───────────────────────────────────────────────── */
// Insert a copy of the slide on stage right after it, and go to the copy.
// The copy is fully independent: its own config (media and widgets, the
// widgets with fresh ids so they run as separate instances, seeded with the
// originals' current state), its own annotations and text boxes.
//   · PDF page → a PDF entry for the same page with its own cfgId
//   · blank    → a new blank with a new blankId
//   · view     → a new view slide pointing at the same two panes
let _duplicating = false;
async function duplicateCurrentSlide() {
    const s = _state;
    if (_duplicating || !s.slideStructure.length) return;
    const src = s.slideStructure[s.currentSlide];
    if (!src) return;
    _duplicating = true;
    try {
        // Commit the strokes on stage so the copy gets them.
        bus.emit('annotations:flush');

        const stamp = Date.now();
        let copy;
        if (src.type === 'view') {
            copy = { ...src, viewId: `v${stamp}` };
        } else if (src.type === 'blank') {
            copy = { type: 'blank', blankId: `b${stamp}`, parent: src.parent ?? null };
            if (src.paper) copy.paper = { ...src.paper };
        } else {
            copy = { type: 'pdf', pdfIndex: src.pdfIndex, cfgId: `d${stamp}` };
        }
        if (src.hidden) copy.hidden = true;   // same visibility as the original
        if (src.title) copy.title = src.title;

        // Clone the config (media + widgets) under the copy's key.
        const srcKey = configKeyOf(src);
        const newKey = configKeyOf(copy);
        if (newKey != null && srcKey != null) {
            const srcCfg = await _readConfig(srcKey);
            if (srcCfg) {
                const cfg = JSON.parse(JSON.stringify(srcCfg));
                if (Array.isArray(cfg.widgets) && cfg.widgets.length) {
                    const oldIds = cfg.widgets.map(w => String(w.id));
                    const states = await requestWidgetStates(oldIds);
                    const seeded = {};
                    cfg.widgets.forEach((w, i) => {
                        const oldId = String(w.id);
                        w.id = `widget_${stamp}_${i}`;
                        if (states[oldId] !== undefined) seeded[w.id] = states[oldId];
                    });
                    seedWidgetStates(seeded);
                }
                s.slideConfigs[newKey] = cfg;
            } else {
                s.slideConfigs[newKey] = null;
            }
        }

        const from = s.currentSlide;
        const ins = from + 1;
        s.slideStructure.splice(ins, 0, copy);
        remapSlideIndices(shiftedFrom(ins));
        // After the remap the source is still at `from`; copy its keyed data.
        if (s.annotations?.[from]) s.annotations[ins] = s.annotations[from];
        if (s.textBoxes?.[from]) s.textBoxes[ins] = JSON.parse(JSON.stringify(s.textBoxes[from]));

        bus.emit('nav:refresh');
        bus.emit('slide:goto', ins);
    } finally {
        _duplicating = false;
    }
}

// A slide's config as it stands: the in-memory copy if it has been loaded
// (possibly edited) this session, else the file in the deck.
async function _readConfig(key) {
    const cfgs = _state.slideConfigs || {};
    if (Object.prototype.hasOwnProperty.call(cfgs, key) && cfgs[key] !== undefined) return cfgs[key];
    try {
        const f = _state.zipFile?.file(`config/s${key}.json`);
        return f ? JSON.parse(await f.async('string')) : null;
    } catch { return null; }
}
