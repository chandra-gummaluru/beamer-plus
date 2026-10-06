/**
 * Beamer+ main orchestrator.
 * Owns the shared presenter state, slide navigation and rendering, and the
 * split view. Feature modules (annotations, media, spotlight, editor, …) are
 * wired up here and communicate through the shared event bus.
 */
import { bus, addHoldListener } from './core/events.js';
import { initModal } from './core/modal.js';
import { Canvas } from './core/canvas.js';
import { updateWidgetPositions,
         parkWidgets, discardParkedWidgets, clearAllParked, setWidgetStates } from './core/iframe-widget-renderer.js';

import { initToolbar, initToolbarDrag } from './annotations/toolbar.js';
import { initPenSlots } from './annotations/pen-slots.js';
import { initShapeTools } from './annotations/shape-tools.js';
import { initTextAnnotations, wireTextCanvas, commitOpenTextEditor,
         clearTextBoxes, resetAllTextBoxes } from './annotations/text-annotate.js';

import { initNavigator } from './slides/navigator.js';
import { initThumbnails } from './slides/thumbnails.js';
import { initSlideStructure, getSlideLabels, slideUid, configKeyOf, realSlideCount, isDeletableSlide } from './slides/structure.js';
import { initNavDrawer, isNavCollapsed, setNavCollapsed } from './slides/drawer.js';
import { initReveals, renderReveals, resetRevealsOnArrival, stepReveal, updateStepBadge } from './slides/reveals.js';
import { applyPaper } from './slides/paper.js';
import { initSpotlight, hideSpotlight, renderSpotlight,
         setWidgetInteractivityForSpotlight } from './slides/spotlight.js';
import { initMagnifier, hideMagnifier } from './slides/magnifier.js';
import { initMedia, renderMedia, updateMediaPositions, resetMediaCache } from './slides/media.js';

import { initSettings, loadShortcuts } from './app/settings.js';
import { initUploader } from './app/uploader.js';
import { startTour } from './app/tour.js';
import { initEditor } from './editor/editor.js';
import { getSessionId, sessionUrl, saveLastSession } from './app/session.js';

/* ─── Render generation counters ─────────────────────────────── */
// Incremented each time a new render starts for each pane.
// Used to detect when a slow earlier render finishes after a faster later
// one has already taken over, so we don't let the stale render overwrite
// the slideKey that the fresh render already committed.
const _renderGen = { L: 0, R: 0 };

/* ─── shared state ────────────────────────────────────────────── */
const state = {
    currentSlide: 0,
    totalSlides: 0,
    bookmarks: {},
    splitView: false,
    rightSlideIndex: 0,
    currentViewIndex: null,   // deck index of the view slide driving the active split (null for manual splits)
    splitRatio: 50,
    annotationTool: 'hand',
    activePenSlot: 0,
    zipFile: null,
    slideStructure: [],
    slideConfigs: {},
    mediaCache: {},
    annotations: {},
    availableModels: [],
    annCvs: null,
    pdfCvs: null,
    annCvs2: null,
    pdfCvs2: null,
    activeAnnCvs: null,   // annotation pane the user last drew on (drives undo/redo/clear in split view)
    slideThumbnailCache: {},
    _pdfDocPromise: null,   // memoized parse of the current slides.pdf (see getPdfDoc)
    spotlight: { visible: false, pane: 'left', x: 0.5, y: 0.5 },
    spotlightOverlays: {},
};
window.beamerState = state;

/* ─── robust file reading ─────────────────────────────────────── */
// Reading a user-picked file can reject with NotFoundError ("A requested file
// or directory could not be found…") when the file lives in a cloud-synced
// folder as an "online-only" placeholder (OneDrive Files On-Demand, iCloud,
// Google Drive) or was moved/changed after it was selected. Retry once — the
// first read often triggers the OS to hydrate the file — then surface a clear,
// actionable message instead of the raw DOMException.
async function readUserFileBytes(file) {
    try {
        return await file.arrayBuffer();
    } catch (err) {
        if (err?.name !== 'NotFoundError') throw err;
        await new Promise(r => setTimeout(r, 400));
        try {
            return await file.arrayBuffer();
        } catch (_) {
            throw new Error(
                `Couldn't read "${file.name}". If it's stored in OneDrive, iCloud, ` +
                `or Google Drive it may be online-only — right-click it and choose ` +
                `"Always keep on this device" (or open it once to download it), ` +
                `then try uploading again.`
            );
        }
    }
}

// The uploaded file's name without its extension — what Save names the ZIP.
function deckNameOf(file) {
    const n = String(file?.name || '').replace(/\.(zip|pdf)$/i, '').trim();
    return n || 'presentation';
}

/* ─── bootstrap ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    const sessionId = getSessionId();
    if (!sessionId) {
        window.location.replace('/');
        return;
    }
    saveLastSession(sessionId);

    // splash
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash) { splash.style.opacity = '0'; setTimeout(() => splash.remove(), 400); }
    }, 1600);

    // core
    initModal(state);

    // canvases
    const annContainer  = document.getElementById('ann-canvas');
    const pdfContainer  = document.getElementById('pdf-canvas');
    const annContainer2 = document.getElementById('ann-canvas-2');
    const pdfContainer2 = document.getElementById('pdf-canvas-2');

    state.annCvs = new Canvas(annContainer, true);
    state.pdfCvs = new Canvas(pdfContainer, false);
    wireTextCanvas(state.annCvs, state);
    state.annCvs.setHistoryChangeHandler(updateHistoryBtns);
    updateHistoryBtns();
    sizeSlideCanvases();   // set pixel-exact 4:3 dimensions before any render
    // The Canvas constructors above read their container size before
    // sizeSlideCanvases() ran, so #ann-canvas (position:absolute, no CSS size)
    // measured 0×0 and the annotation bitmap is 0×0 — drawing produces nothing
    // until some resize path runs. Sync the bitmaps to the now-correct
    // container size so annotations work on first load (previously they only
    // started working after toggling split view / resizing the window).
    state.annCvs.resizeOnly();
    state.pdfCvs.resizeOnly();

    // modules
    initNavigator(state);
    initThumbnails(state);
    initSlideStructure(state);
    initNavDrawer();
    initReveals(state);
    initMedia(state);
    initToolbar(state);
    initPenSlots(state);
    initToolbarDrag();   // after pen slots, so the first clamp sees the full rail
    initShapeTools(state);
    initTextAnnotations(state);
    initUploader(state);
    initEditor(state);
    initSettings();
    // Must run before applyDefaultPen(): that call emits a 'tool:change' to
    // sync other modules' tracked "previous tool" state (see below), and
    // spotlight.js's own 'tool:change' handler dereferences state that only
    // exists once initSpotlight(state) has run.
    initSpotlight(state);
    initMagnifier(state);

    // pen + hand defaults
    applyDefaultPen();
    wireHandButton();
    wireEraserButton();
    wireFocusMode();
    wireSplitViewButton(annContainer2, pdfContainer2);
    wireBookmarkButton();
    wireUndoRedo();
    wireAnnotationClear();
    wireKeyboardNav();
    wireResizeAndFullscreen();
    document.getElementById('mute-btn')?.addEventListener('click', () => toggleMute());
    updateStageEmptyState();
    maybeStartTourFromUrl();

    // annotation sync + active-pane tracking
    state.activeAnnCvs = state.annCvs;
    wireAnnCanvasActivation(state.annCvs);

    // load available AI models
    fetch(sessionUrl('/api/models')).then(r => r.json()).then(d => {
        state.availableModels = d.models || [];
    }).catch(() => { state.availableModels = []; });

    // Upload bus handlers
    bus.on('upload:zip', async (file) => {
        // A new deck replaces this one: close any split first.
        if (state.splitView) await setSplitActive(false);
        const modal = window.BeamerModal;
        modal?.show({ kind: 'loading', title: 'Uploading…', message: 'Parsing ZIP…' });
        try {
            const data = await readUserFileBytes(file);
            const zip  = await JSZip.loadAsync(data);
            await uploadZipToServer(zip, modal, file.name);
        } catch (err) {
            modal?.close();
            window.BeamerModal?.show({ kind: 'error', title: 'Upload failed', message: err.message });
        }
    });

    bus.on('upload:pdf', async (file) => {
        if (state.splitView) await setSplitActive(false);
        await loadPdfPresentation(file);
    });

    bus.emit('app:ready');
});

async function uploadZipToServer(zip, modal, name = 'presentation.zip') {
    modal?.show({ kind: 'loading', title: 'Uploading…', message: 'Sending to server…' });
    const blob  = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const form  = new FormData();
    form.append('file', blob, 'presentation.zip');
    const resp  = await fetch(sessionUrl('/upload'), { method: 'POST', body: form });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Server error' }));
        throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const file = new File([blob], name, { type: 'application/zip' });
    await loadZipPresentation(file);
}

/* ─── annotation canvas helpers ───────────────────────────────── */
// Apply an operation to every annotation canvas (left + right pane) so tool,
// pen, and shape selections configure whichever pane the user draws on.
function forEachAnnCvs(fn) {
    if (state.annCvs)  fn(state.annCvs);
    if (state.annCvs2) fn(state.annCvs2);
}

// The annotation pane the user last drew on — drives undo/redo/clear and the
// history-button state. Outside split view (or before any draw) this is the
// left pane.
function activeAnnCvs() {
    return (state.splitView && state.activeAnnCvs) ? state.activeAnnCvs : state.annCvs;
}

// Deck index backing the active annotation pane, for persisting its strokes.
function activeAnnSlide() {
    return (state.splitView && state.activeAnnCvs === state.annCvs2)
        ? state.rightSlideIndex : state.currentSlide;
}

// Mark a canvas active on pointerdown (so shared controls target it) and
// persist its strokes on pointerup.
function wireAnnCanvasActivation(cvs) {
    cvs.canvas.addEventListener('pointerdown', () => {
        state.activeAnnCvs = cvs;
        updateHistoryBtns();
    });
    cvs.canvas.addEventListener('pointerup', () => syncAnnotations());
}

/* ─── history buttons ─────────────────────────────────────────── */
function updateHistoryBtns() {
    const undo = document.getElementById('annotation-undo');
    const redo = document.getElementById('annotation-redo');
    const cvs  = activeAnnCvs();
    if (undo) undo.disabled = !cvs?.canUndo();
    if (redo) redo.disabled = !cvs?.canRedo();
}

function applyDefaultPen() {
    const handBtn = document.querySelector('[data-tool="hand"], #hand-btn');
    state.annotationTool = 'hand';
    forEachAnnCvs(c => c.setPointerMode('hand'));
    setShapeSidebarVisible(false);
    setTextToolActive(false);
    clearToolSelection();
    handBtn?.classList.add('btn_selected');
    // Applied directly (not via a button click) since wireHandButton() hasn't
    // registered its listener yet at this point in bootstrap — but still
    // announce it on the bus so modules that track "the last real tool"
    // (text-annotate's revert-on-commit, spotlight's restore-on-click) see
    // 'hand' as the true starting point rather than whatever initPenSlots'
    // one-time default-pen click happened to leave behind.
    bus.emit('tool:change', 'hand');
}

function wireHandButton() {
    const btn = document.querySelector('[data-tool="hand"], #hand-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        commitOpenTextEditor(state);
        state.annotationTool = 'hand';
        forEachAnnCvs(c => c.setPointerMode('hand'));
        setShapeSidebarVisible(false);
        setTextToolActive(false);
        clearToolSelection();
        btn.classList.add('btn_selected');
    });
}

function wireEraserButton() {
    const btn = document.querySelector('[data-tool="eraser"], #eraser-btn');
    if (!btn) return;
    let held = false;
    addHoldListener(btn, () => {
        held = true;
        activeAnnCvs().clearAndCommit();
        state.annotations[activeAnnSlide()] = null;
        clearTextBoxes(state, activeAnnSlide());
    }, 550);
    btn.addEventListener('click', () => {
        if (held) { held = false; return; }
        commitOpenTextEditor(state);
        state.annotationTool = 'erase';
        forEachAnnCvs(c => c.setPointerMode('erase'));
        setShapeSidebarVisible(false);
        setTextToolActive(false);
        clearToolSelection();
        btn.classList.add('btn_selected');
    });
}

function clearToolSelection() {
    document.querySelectorAll('#tool-container .btn').forEach(b => b.classList.remove('btn_selected'));
}

/* bus: pen:select from pen-slots module */
bus.on('pen:select', (pen) => {
    commitOpenTextEditor(state);
    forEachAnnCvs(c => {
        c.setPointerMode(pen.mode === 'highlight' ? 'highlight' : 'draw');
        c.setStrokeColor(pen.color);
        c.setStrokeWidth(pen.size);
    });
    setShapeSidebarVisible(false);
    setTextToolActive(false);
});

/* bus: tool:change from toolbar module */
bus.on('tool:change', (tool) => {
    if (tool !== 'text') commitOpenTextEditor(state);
    state.annotationTool = tool;
    // Map toolbar tool names to canvas pointer modes
    const modeMap = { eraser: 'erase', laser: 'hand', select: 'hand', shape: 'shape', hand: 'hand', spotlight: 'hand', magnify: 'hand', text: 'text' };
    const mode = modeMap[tool] || 'hand';
    forEachAnnCvs(c => c.setPointerMode(mode));
    if (tool !== 'shape') setShapeSidebarVisible(false);
    setTextToolActive(tool === 'text');
    // The magnifier needs the same thing the spotlight does: widgets that
    // don't swallow pointer moves, or the lens freezes over them.
    setWidgetInteractivityForSpotlight(tool === 'spotlight' || tool === 'magnify');
    if (tool !== 'spotlight') hideSpotlight(true);
    if (tool !== 'magnify') hideMagnifier();
});

bus.on('shape:select', (shape) => {
    forEachAnnCvs(c => {
        c.setShapeTool(shape);
        c.setPointerMode('shape');
    });
});

function setShapeSidebarVisible(visible) {
    const sidebar = document.getElementById('shape-sidebar');
    if (sidebar) sidebar.style.display = visible ? 'flex' : 'none';
    document.body.classList.toggle('shape-tools-visible', visible);
}

// While the text tool is active, the annotation canvas needs to sit above
// widgets/video/model-viewer so a tap over them places text instead of
// interacting with the widget (see annotations.css for the z-index rule).
// This tracks tool selection, not whether a box is actually open.
function setTextToolActive(active) {
    document.body.classList.toggle('text-tool-active', active);
}

// The size-dot sidebar, by contrast, should only show once a box is actually
// open for editing — not just because the Text tool is selected.
function setTextSizeSidebarVisible(visible) {
    const sidebar = document.getElementById('text-size-sidebar');
    if (sidebar) sidebar.style.display = visible ? 'flex' : 'none';
    document.body.classList.toggle('text-tool-visible', visible);
}
bus.on('textbox:opened', () => setTextSizeSidebarVisible(true));
bus.on('textbox:closed', () => setTextSizeSidebarVisible(false));

/* ─── undo / redo / clear ─────────────────────────────────────── */
function wireUndoRedo() {
    document.getElementById('annotation-undo')?.addEventListener('click', async () => {
        await activeAnnCvs().undo();
        syncAnnotations();
        updateHistoryBtns();
    });
    document.getElementById('annotation-redo')?.addEventListener('click', async () => {
        await activeAnnCvs().redo();
        syncAnnotations();
        updateHistoryBtns();
    });
}

function wireAnnotationClear() {
    document.getElementById('annotation-clear-btn')?.addEventListener('click', () => {
        activeAnnCvs().clearAndCommit();
        state.annotations[activeAnnSlide()] = null;
        clearTextBoxes(state, activeAnnSlide());
    });
}

/* ─── keyboard navigation ─────────────────────────────────────── */
function wireKeyboardNav() {
    document.addEventListener('keydown', (e) => {
        if (e.target.matches('input,textarea,[contenteditable]')) return;

        // Fixed: undo / redo
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            document.getElementById('annotation-undo')?.click();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
            e.preventDefault();
            document.getElementById('annotation-redo')?.click();
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        // Fixed: navigation & escape
        if (e.key === 'ArrowLeft'  || e.key === 'PageUp')   navStep(-1, e.repeat);
        if (e.key === 'ArrowRight' || e.key === 'PageDown') navStep(+1, e.repeat);
        if (e.key === 'Escape') { bus.emit('ui:escape'); BeamerModal?.close(); }
        if (e.key === '.' && state.slideStructure.length) toggleMute();

        // Configurable shortcuts
        const sc = loadShortcuts();
        if (e.key === sc.hand)             document.querySelector('[data-tool="hand"], #hand-btn')?.click();
        if (e.key === sc.eraser)           document.querySelector('[data-tool="eraser"]')?.click();
        if (e.key === sc.spotlight)        document.querySelector('[data-tool="spotlight"], #spotlight-btn')?.click();
        if (e.key === sc.magnify)          document.querySelector('[data-tool="magnify"], #magnify-btn')?.click();
        if (e.key === sc.bookmark && state.slideStructure.length) toggleBookmark(state.currentSlide);
        if (e.key === sc.clearAnnotations) document.getElementById('annotation-clear-btn')?.click();
        if (e.key === sc.splitView)        document.getElementById('split-toggle')?.click();
        if (e.key === sc.focusMode)        toggleFocusMode();
        [sc.pen1, sc.pen2, sc.pen3, sc.pen4, sc.pen5].forEach((key, i) => {
            if (key && e.key === key) document.querySelectorAll('#pen-slots .pen-slot-btn')[i]?.click();
        });
    });

    // Widget iframes can't bubble keydown events out to this document, so
    // widgets forward unhandled nav keys via postMessage instead (see
    // widget-nav-bridge injected in iframe-widget-renderer.js).
    window.addEventListener('message', (e) => {
        if (e.data?.type !== 'widget-nav') return;
        const key = e.data.key;
        if (key === 'ArrowLeft'  || key === 'PageUp')   navStep(-1, !!e.data.repeat);
        if (key === 'ArrowRight' || key === 'PageDown') navStep(+1, !!e.data.repeat);
    });
}

// ── One navigation at a time ─────────────────────────────────────────────
// Moving to a slide is async (commit the text editor, park widgets, render
// the PDF page, load its config and media), and every step of it reads and
// writes the current slide. Two moves running at once — a held arrow key
// fires ~30 keydowns a second — interleave: a render bails half-way because
// the slide changed under it, a loading overlay is left up, ink is saved
// onto the wrong slide, split view opens and closes over itself. So every
// move goes through one queue and runs to the end before the next starts.
let _navChain   = Promise.resolve();
let _navPending = 0;          // sequential steps queued or running

function queueNav(fn) {
    const run = _navChain.then(fn).catch(err => console.error('[nav] navigation failed', err));
    _navChain = run;
    return run;
}

// Direct jumps (thumbnail, bookmark, editor) wait their turn too.
function goToSlide(i, direction = null, isSplitPaneNav = false) {
    return queueNav(() => _goToSlide(i, direction, isSplitPaneNav));
}

// Sequential navigation: a slide's reveal steps come before moving on. The
// target is worked out when the step runs, not when the key was pressed, so
// queued steps count from wherever the previous one landed. A held key
// (auto-repeat) only queues a step when nothing is pending, so holding the
// arrow moves as fast as slides render and stops as soon as it's released,
// rather than draining a backlog afterwards.
function navStep(dir, repeat = false) {
    if (repeat && _navPending > 0) return;
    if (_navPending >= 3) return;       // a burst of taps: don't run away
    _navPending++;
    queueNav(async () => {
        if (stepReveal(dir)) return;
        if (dir > 0) await _goToSlide(state.currentSlide + 1, 'forward');
        else         await _goToSlide(state.currentSlide - 1, 'back');
    }).finally(() => { _navPending--; });
}

/* ─── mute ─────────────────────────────────────────────────────── */
// Blanks the stage — slide, widgets, media and ink — until toggled again,
// e.g. to take the room's attention off the screen. Navigation still works
// underneath, so you can move on while hidden. Playing media is paused.
function toggleMute(force) {
    const on = typeof force === 'boolean' ? force : !document.body.classList.contains('slide-muted');
    document.body.classList.toggle('slide-muted', on);
    const btn = document.getElementById('mute-btn');
    if (btn) {
        btn.classList.toggle('btn_selected', on);
        btn.setAttribute('aria-pressed', String(on));
        btn.title = on ? 'Show slide (.)' : 'Hide slide (.)';
    }
    if (on) document.querySelectorAll('#main-content video, #main-content audio').forEach(m => { try { m.pause(); } catch (_) {} });
}

/* ─── guided tour ─────────────────────────────────────────────── */
// Launched from the welcome page's "Take a tour" button, which creates a
// session and lands here with ?tour=1. Loads the demo deck if nothing is
// loaded yet, so every step has something to point at.
function launchTour() {
    if (isNavCollapsed()) setNavCollapsed(false, { persist: false });
    const loader = state.zipFile ? null : async () => {
        window.BeamerModal?.show({ kind: 'loading', title: 'Loading demo…', message: 'Fetching demo presentation…' });
        const resp = await fetch('/api/demo-zip');
        if (!resp.ok) { window.BeamerModal?.close(); return; }
        const blob = await resp.blob();
        await loadZipPresentation(new File([blob], 'demo.zip', { type: 'application/zip' }));
    };
    startTour(loader);
}

function maybeStartTourFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('tour')) return;
    // Drop the flag so a reload doesn't restart the tour.
    params.delete('tour');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
    // Wait out the splash screen (removed ~2s after load).
    setTimeout(launchTour, 2100);
}

/* ─── bookmark button ─────────────────────────────────────────── */
function wireBookmarkButton() {
    document.getElementById('bookmark-btn')?.addEventListener('click', () => {
        toggleBookmark(state.currentSlide);
    });
}

function toggleBookmark(i) {
    if (state.bookmarks[i]) delete state.bookmarks[i];
    else state.bookmarks[i] = true;
    bus.emit('bookmarks:changed', state.bookmarks);
    populateBookmarkPins();
}

/* ─── focus mode ─────────────────────────────────────────────── */
function toggleFocusMode() {
    // resizeOnly() below blanks both bitmaps, so commit the ink first…
    saveCurrentAnnotations();
    document.body.classList.toggle('focus-mode');
    setTimeout(async () => {
        sizeSlideCanvases();
        state.annCvs?.resizeOnly?.();
        state.pdfCvs?.resizeOnly?.();
        if (state.splitView) {
            state.annCvs2?.resizeOnly?.();
            state.pdfCvs2?.resizeOnly?.();
        }
        // …and redraw the slide at the new size. Without this the stage stayed
        // empty until the next navigation repainted it.
        if (!state.slideStructure.length) return;
        if (state.splitView) await renderSplitSlides(state.currentSlide, state.rightSlideIndex);
        else await renderLogicalSlide(state.currentSlide, false, true);
        _updateAllOverlayPositions();
    }, 300); // wait for CSS transition to finish
}

function wireFocusMode() {
    // No button — feature is keyboard-only (configurable shortcut + Escape to exit).
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('focus-mode')) {
            toggleFocusMode();
        }
    });
}

/* ─── split-view ──────────────────────────────────────────────── */
function wireSplitViewButton(annContainer2, pdfContainer2) {
    const btn = document.getElementById('split-toggle');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        await commitOpenTextEditor(state);
        const enteringSplit = !state.splitView;
        // Split view needs two real slides (view slides don't count).
        if (enteringSplit && realSlideCount(state.slideStructure) < 2) return;
        // Save before setSplitActive — resizeOnly() inside it clears the canvas
        saveCurrentAnnotations();
        // Show overlay(s) immediately before any layout work
        _slideOverlay(false)?.classList.add('visible');
        if (enteringSplit) _slideOverlay(true)?.classList.add('visible');
        await setSplitActive(enteringSplit);
        if (state.zipFile) {
            if (state.splitView) {
                await renderSplitSlides(state.currentSlide, state.rightSlideIndex);
            } else {
                await renderLogicalSlide(state.currentSlide);
            }
        } else {
            _slideOverlay(false)?.classList.remove('visible');
            _slideOverlay(true)?.classList.remove('visible');
        }
    });

    // Divider dragging for resizing — pointer events so touch works too
    const divider = document.getElementById('split-view-divider');
    let isDragging = false;

    function _onDividerDragEnd() {
        const wasDragging = isDragging;
        isDragging = false;
        divider.classList.remove('active');
        // Editing a view slide: dragging the divider on stage sets its ratio
        // (the view panel's split picker follows).
        if (wasDragging && state.editMode && state.currentViewIndex != null) {
            const view = state.slideStructure[state.currentViewIndex];
            if (view?.type === 'view') {
                view.ratio = Math.round(state.splitRatio);
                bus.emit('view:ratio-dragged', view.ratio);
            }
        }
        // Re-render both panes after divider resize — only if we were actually dragging
        if (wasDragging && state.splitView) {
            setTimeout(async () => {
                saveCurrentAnnotations();
                state.annCvs.resizeOnly?.();
                state.annCvs2?.resizeOnly?.();
                updateWidgetPositions(document.getElementById('pdf-canvas'));
                updateWidgetPositions(document.getElementById('pdf-canvas-2'));
                updateMediaPositions(document.getElementById('pdf-canvas'));
                updateMediaPositions(document.getElementById('pdf-canvas-2'));
                await renderSplitSlides(state.currentSlide, state.rightSlideIndex);
                bus.emit('split:resized');
            }, 50);
        }
    }

    if (divider) {
        divider.addEventListener('pointerdown', (e) => {
            if (state.editMode) return;   // locked in edit mode; slider controls ratio instead
            isDragging = true;
            divider.classList.add('active');
            // Capture keeps pointermove/pointerup firing on this element even
            // after the pointer leaves it, which is essential for touch drag.
            divider.setPointerCapture(e.pointerId);
        });

        divider.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            const mainContent = document.getElementById('main-content');
            const leftContainer = document.getElementById('pdf-container');
            const rightContainer = document.getElementById('pdf-container-2');
            if (!mainContent || !leftContainer || !rightContainer) return;

            const rect = mainContent.getBoundingClientRect();
            const newLeftPercent = ((e.clientX - rect.left) / rect.width) * 100;
            applySplitRatio(newLeftPercent);
            // Recompute 4:3 canvas sizes now that the containers have new widths.
            sizeSlideCanvases();
            // Widgets/video/audio/models are absolutely positioned in px within
            // the canvas container and don't resize with it automatically —
            // without this they'd stay frozen at their old offsets until drag end.
            _updateAllOverlayPositions();
        });

        divider.addEventListener('pointerup',     _onDividerDragEnd);
        divider.addEventListener('pointercancel', _onDividerDragEnd);
    }

    // Horizontal scroll on wheel in split view
    document.getElementById('slide-navigator')?.addEventListener('wheel', (e) => {
        if (!state.splitView) return;
        const scroller = document.getElementById('slide-nav-slides');
        if (!scroller) return;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (delta === 0) return;
        e.preventDefault();
        scroller.scrollLeft += delta;
    }, { passive: false });
}

function getSplitRatioBounds() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return { min: 20, max: 80 };
    const rect = mainContent.getBoundingClientRect();
    const totalWidth  = rect.width;
    const totalHeight = rect.height;
    if (!totalWidth || !totalHeight) return { min: 20, max: 80 };
    // Compute the widest a single pane can be while keeping height as the
    // binding 4:3 constraint (so the full slide height remains visible).
    const maxContainerWidth = totalHeight * (4 / 3);
    const maxPercent = (maxContainerWidth / totalWidth) * 100;
    const min = Math.max(100 - maxPercent, 20);
    const max = Math.min(maxPercent, 80);
    if (min > max) return { min: 50, max: 50 };
    return { min, max };
}

function applySplitRatio(ratioPercent) {
    const leftContainer = document.getElementById('pdf-container');
    const rightContainer = document.getElementById('pdf-container-2');
    if (!leftContainer || !rightContainer) return state.splitRatio;

    const bounds = getSplitRatioBounds();
    const clamped = Math.max(bounds.min, Math.min(bounds.max, ratioPercent));
    state.splitRatio = clamped;
    leftContainer.style.flex = `1 1 ${clamped}%`;
    rightContainer.style.flex = `1 1 ${100 - clamped}%`;
    return clamped;
}

/* ─── undefined split-view panes ──────────────────────────────── */
// A view slide's pane is undefined when its slide was deleted (the remap
// sets it to null), was never picked, or points at something that isn't a
// real slide. The navigator shows such a pane as "?" and the stage shows an
// "Undefined" card in its place; state.missingPanes says which pane(s) of
// the split on stage are standing in like that.
function validPane(p) {
    const obj = Number.isInteger(p) ? state.slideStructure[p] : null;
    return obj && obj.type !== 'view' ? p : null;
}

function paneContainer(isRight) {
    return document.getElementById(isRight ? 'pdf-container-2' : 'pdf-container');
}

function showUndefinedPane(isRight, on) {
    const pane = paneContainer(isRight);
    if (!pane) return;
    let card = pane.querySelector('.pane-undefined');
    if (!on) { if (card) card.hidden = true; return; }
    if (!card) {
        card = document.createElement('div');
        card.className = 'pane-undefined';
        // Same voice as the empty stage: a hand-drawn mark, a serif title,
        // one quiet line. The mark is an empty slide outline, dashed.
        card.innerHTML =
            '<svg class="pane-undefined-icon" viewBox="0 0 72 54" fill="none" aria-hidden="true">' +
                '<rect class="pane-undefined-outline" x="6" y="6" width="60" height="42" rx="4"/>' +
                '<path class="pane-undefined-q" d="M30 21 Q 30 15, 36 15 T 42 21 Q 42 25, 36 27 L 36 31"/>' +
                '<circle class="pane-undefined-dot" cx="36" cy="37.5" r="1.6"/>' +
            '</svg>' +
            '<p class="pane-undefined-title">Undefined</p>' +
            '<p class="pane-undefined-hint">This pane\'s slide was deleted or never chosen.</p>';
        pane.appendChild(card);
    }
    card.hidden = false;
    sizeSlideCanvases();
}

function clearMissingPanes() {
    state.missingPanes = null;
    showUndefinedPane(false, false);
    showUndefinedPane(true, false);
}

// Empty a pane that has no slide to show: its widgets are parked (not
// destroyed — they belong to a real slide that may come back) and its media,
// slide image and ink are cleared. The Undefined card covers whatever is left.
function blankPane(isRight) {
    const paneKey = isRight ? 'R' : 'L';
    ++_renderGen[paneKey];   // a render still in flight for this pane is stale now
    const slideContainer = document.getElementById(isRight ? 'pdf-canvas-2' : 'pdf-canvas');
    const prevKey = slideContainer?.dataset?.slideKey;
    if (slideContainer && prevKey != null) {
        parkWidgets(slideContainer, prevKey);
        slideContainer.querySelectorAll('video,audio,model-viewer').forEach(el => el.remove());
        delete slideContainer.dataset.slideKey;
    }
    if (slideContainer) applyPaper(slideContainer, null);
    const cvs    = isRight ? state.pdfCvs2 : state.pdfCvs;
    const annCvs = isRight ? state.annCvs2 : state.annCvs;
    if (cvs?.canvas) cvs.canvas.style.visibility = 'hidden';
    annCvs?.clear?.();
    annCvs?.resetHistory?.();
    _slideOverlay(isRight)?.classList.remove('visible');
    showUndefinedPane(isRight, true);
}

// Show a view slide with one or both panes undefined. The real pane renders
// as usual; the other gets the Undefined card. With one pane real, both
// currentSlide and rightSlideIndex point at it (the split code needs real
// indices) and state.missingPanes keeps anything from treating the undefined
// pane as a second copy of that slide — nothing renders, saves ink or
// widgets for it. With neither, both point at the view slide itself.
async function showViewWithUndefinedPane(viewIdx, L, R, direction) {
    const obj = state.slideStructure[viewIdx];
    saveCurrentAnnotations();                      // the panes being left, first
    const anchor = L ?? R ?? viewIdx;
    if (L != null || R != null) resetRevealsOnArrival(state.slideStructure[anchor], direction);
    state.missingPanes = { left: L == null, right: R == null };
    // Edit mode previews the view as it will present: at its own ratio.
    const ratio = obj?.ratio ?? (state.editMode ? 50 : null);
    // setSplitActive renders the right pane itself unless the split was
    // already up with this right index.
    const rightRendered = !(state.splitView && state.rightSlideIndex === anchor);
    await setSplitActive(true, anchor, ratio);
    if (state.rightSlideIndex !== anchor) state.rightSlideIndex = anchor;
    state.currentViewIndex = viewIdx;
    state.currentSlide = anchor;

    if (L != null) { showUndefinedPane(false, false); await renderLogicalSlide(L, false); }
    else blankPane(false);
    if (R != null) { showUndefinedPane(true, false); if (!rightRendered) await renderLogicalSlide(R, true); }
    else blankPane(true);

    updateSlideNavigator();
    updateBlankSlideButtons();
    updateStepBadge();
    bus.emit('slide:changed', state.currentSlide);
}

/* ─── slide navigation ────────────────────────────────────────── */
bus.on('slide:goto', (i) => goToSlide(i));
bus.on('slide:next', () => navStep(+1));
bus.on('slide:prev', () => navStep(-1));
bus.on('slide:goto-right', (i) => queueNav(async () => {
    if (!state.splitView || i === state.currentSlide) return;
    await commitOpenTextEditor(state);
    saveCurrentAnnotations();
    _slideOverlay(true)?.classList.add('visible');
    if (state.missingPanes?.right) { state.missingPanes.right = false; showUndefinedPane(true, false); }
    state.rightSlideIndex = i;
    resetRevealsOnArrival(state.slideStructure[i], null);
    await renderLogicalSlide(i, true);
    updateSlideNavigator();
    bus.emit('slide:changed', state.currentSlide);
}));

async function _goToSlide(i, direction = null, isSplitPaneNav = false) {
    // Sequential nav out of a split works from the view, not from `i` (the
    // left pane ± 1), so `i` may be off either end — e.g. the left pane is the
    // deck's first page. Only bounds-check where `i` is the destination.
    // (Edit mode steps the same way through a view slide — the split there
    // is the view's preview.)
    const viewSplit = state.splitView && state.currentViewIndex != null;
    const leavingSplit = !isSplitPaneNav && state.splitView && direction !== null && (viewSplit || !state.editMode);
    if (!leavingSplit && (i < 0 || i >= state.slideStructure.length)) return;
    await commitOpenTextEditor(state);

    // A direct jump (bookmark, thumbnail click, tour, etc.) that targets the
    // slide already showing in the right pane would put the same slide on
    // both sides. The navigator's left-zone `is-disabled` class blocks this
    // at the UI level, but that's only one of several callers of goToSlide —
    // this mirrors the symmetric guard in the 'slide:goto-right' handler so
    // it's enforced regardless of caller. Sequential nav (direction set) and
    // internal split-pane navigation (isSplitPaneNav) have their own handling
    // above/below and are exempt.
    // (A view slide is never really in the right pane — with both its panes
    // undefined, rightSlideIndex only stands in at its index.)
    // In edit mode a split is only ever a view slide's preview: picking any
    // other slide (in the navigator, say) leaves it and shows that slide.
    if (direction === null && !isSplitPaneNav && state.editMode && state.splitView &&
        state.slideStructure[i]?.type !== 'view') {
        await setSplitActive(false);
    }
    if (direction === null && !isSplitPaneNav && state.splitView && i === state.rightSlideIndex &&
        state.slideStructure[i]?.type !== 'view') return;

    hideSpotlight(true);
    hideMagnifier();

    // Presentation-mode sequential nav from within split view.
    //   A view slide's split is a slide of its own: forward / back go to
    //   the next / previous slide in the deck from the view's position,
    //   skipping hidden ones — whatever its panes happen to be (a pane can
    //   be any slide, hidden, or before or after the view).
    //   A manual split (no view slide): forward → the right pane full-screen,
    //   back → the left pane — the reversible A → [A|B] → B → [A|B] → A.
    if (leavingSplit) {
        const viewIdx = state.currentViewIndex;
        let targetIdx;
        if (viewIdx != null) targetIdx = direction === 'forward' ? viewIdx + 1 : viewIdx - 1;
        else targetIdx = direction === 'forward' ? state.rightSlideIndex : state.currentSlide;
        // Where that lands once hidden slides are skipped. Nothing there —
        // the view is the first (or last) thing showing: stay in the split
        // rather than closing it and going nowhere.
        const step = direction === 'forward' ? 1 : -1;
        let landing = targetIdx;
        while (state.slideStructure[landing]?.hidden) landing += step;
        if (landing < 0 || landing >= state.slideStructure.length) {
            // Nothing visible before this view — but the deck may have been
            // opened on a hidden slide and stepped forward from it into the
            // view. Back returns to where you came from, as you'd expect.
            const from = state.viewCameFrom;
            if (direction === 'back' && viewIdx != null && from != null && from < viewIdx &&
                state.slideStructure[from] && state.slideStructure[from].type !== 'view') {
                await setSplitActive(false);
                await _goToSlide(from, null, false);
            }
            return;
        }
        await setSplitActive(false);
        // Pass direction so the hidden-slide while loop runs in the recursive call.
        // Forward: skips right-pane if hidden, continues to next visible slide.
        // Back: skips left-pane if hidden, continues to previous visible slide.
        await _goToSlide(targetIdx, direction, false);
        return;
    }

    // When already inside a split view, skip view slides (to avoid re-triggering
    // the same split view and getting stuck).  When not in split view, allow
    // sequential nav to land on a view slide so the split activates normally.
    // Always skip hidden slides regardless of edit mode — hidden slides are still
    // reachable via direct thumbnail clicks (direction === null bypasses this loop).
    // Direct jumps (direction === null) bypass this entirely.
    if (direction !== null) {
        const step = direction === 'forward' ? 1 : -1;
        while ((state.slideStructure[i]?.type === 'view' && state.splitView) ||
               state.slideStructure[i]?.hidden) {
            i += step;
            if (i < 0 || i >= state.slideStructure.length) return;
        }
    }

    // View slides: activate their pre-configured split layout, then navigate to the left slide.
    // Works in both presentation mode and edit mode (edit mode also shows the split for preview).
    const prelimObj = state.slideStructure[i];
    if (prelimObj?.type === 'view') {
        // Arrowing onto a view slide in edit mode opens its configuration,
        // as clicking it in the navigator does.
        if (state.editMode && direction !== null) bus.emit('view:select', i);
        // Where the presenter stepped in from — Back returns there when no
        // visible slide comes before the view (see above).
        // (Kept when stepping back into a view; a direct jump forgets it.)
        if (!state.splitView && direction === 'forward') state.viewCameFrom = state.currentSlide;
        else if (direction === null) state.viewCameFrom = null;
        const L = validPane(prelimObj.left), R = validPane(prelimObj.right);
        if (L == null || R == null) { await showViewWithUndefinedPane(i, L, R, direction); return; }
        clearMissingPanes();
        const leftIdx = L, rightIdx = R;
        saveCurrentAnnotations();
        // Both panes start with their reveal steps hidden (all shown when
        // arriving backwards); the left pane's goToSlide below won't reset.
        resetRevealsOnArrival(state.slideStructure[leftIdx], direction);
        resetRevealsOnArrival(state.slideStructure[rightIdx], direction);
        const previewRatio = prelimObj.ratio ?? (state.editMode ? 50 : null);
        if (leftIdx !== rightIdx) await setSplitActive(true, rightIdx, previewRatio);
        state.currentViewIndex = i;   // remember which view slide drives this split
        await _goToSlide(leftIdx, null, true);  // isSplitPaneNav — skip auto-close
        return;
    }

    // Show overlay(s) immediately — before any async config loading or layout work
    _slideOverlay(false)?.classList.add('visible');
    if (state.splitView) _slideOverlay(true)?.classList.add('visible');

    // Capture right-pane index before any layout changes so we can detect if it shifted.
    const prevRightIndex = state.rightSlideIndex;

    // Save annotations before any canvas-clearing layout changes. Safe to call
    // even mid-transition: saveCurrentAnnotations() reads the last committed
    // snapshot, not the (possibly resizeOnly-blanked) live canvas.
    saveCurrentAnnotations();

    // Edit mode: if split view is active and we're navigating to a slide that
    // isn't a pane of the currently displayed view, close split view NOW — before
    // any canvas sizing or rendering — so the new slide renders at full-width
    // dimensions. Skip this when called internally from the view-slide handler
    // (isSplitPaneNav = true) so we don't immediately undo the split activation.
    if (!isSplitPaneNav && state.editMode && state.splitView && i !== state.rightSlideIndex) {
        await setSplitActive(false);
    }

    if (!isSplitPaneNav && i !== state.currentSlide) resetRevealsOnArrival(state.slideStructure[i], direction);
    state.currentSlide = i;
    if (state.missingPanes?.left) { state.missingPanes.left = false; showUndefinedPane(false, false); }

    if (state.splitView) {
        const rightChanged = state.rightSlideIndex !== prevRightIndex;
        if (rightChanged) {
            // Both panes need re-rendering
            await renderSplitSlides(i, state.rightSlideIndex);
        } else {
            // Only left pane changed — render it alone and hide its overlay
            _slideOverlay(true)?.classList.remove('visible');
            await renderLogicalSlide(i, false);
        }
    } else {
        await renderLogicalSlide(i);
    }
    updateSlideNavigator();
    updateBlankSlideButtons();
    updateStepBadge();
    bus.emit('slide:changed', i);
}

async function setSplitActive(active, rightIndex = null, splitRatio = null) {
    const annContainer2 = document.getElementById('ann-canvas-2');
    const pdfContainer2 = document.getElementById('pdf-canvas-2');
    const btn           = document.getElementById('split-toggle');

    if (active === state.splitView && (rightIndex === null || rightIndex === state.rightSlideIndex)) return;

    state.splitView = active;
    if (!active) {
        clearMissingPanes();
        state.currentViewIndex = null;   // split closed — no view slide drives it anymore
        state.activeAnnCvs = state.annCvs; // shared controls (undo/clear) go back to the sole pane
    }
    document.body.classList.toggle('split-view-active', active);
    if (btn) btn.classList.toggle('btn_selected', active);

    // Edit, download and upload all work in split view too: entering edit
    // mode shows the view slide's configuration, saving keeps both panes'
    // ink, and an upload closes the split before loading the new deck.

    if (active) {
        if (!state.annCvs2) {
            state.annCvs2 = new Canvas(annContainer2, true);
            state.pdfCvs2 = new Canvas(pdfContainer2, false);
            wireTextCanvas(state.annCvs2, state);
            state.annCvs2.setHistoryChangeHandler(updateHistoryBtns);
            wireAnnCanvasActivation(state.annCvs2);
        }
        // Mirror the left pane's current tool so the right pane is immediately
        // drawable with the same pen/shape/mode the user already selected.
        state.annCvs2.setPointerMode(state.annCvs.pointer_mode);
        state.annCvs2.setStrokeColor(state.annCvs.strokeColor);
        state.annCvs2.setStrokeWidth(state.annCvs.strokeWidth);
        state.annCvs2.setShapeTool(state.annCvs.shapeTool);
        state.annCvs2.setShapeMode(state.annCvs.shapeMode);
        state.rightSlideIndex = rightIndex ?? Math.min(state.currentSlide + 1, state.slideStructure.length - 1);
        applySplitRatio(splitRatio ?? state.splitRatio);
    }

    await new Promise(resolve => setTimeout(resolve, 100));
    sizeSlideCanvases(); // recompute 4:3 sizes for the new split / single layout
    state.annCvs.resizeOnly?.();
    state.pdfCvs.resizeOnly?.();
    if (state.annCvs2) state.annCvs2.resizeOnly?.();
    if (state.pdfCvs2) state.pdfCvs2.resizeOnly?.();

    // Render right pane AFTER the canvas resize — resizeOnly() clears canvas
    // dimensions so any render done before it would be wiped. This is the reason
    // the right slide sometimes appeared blank on first load.
    // An undefined right pane renders nothing (showViewWithUndefinedPane
    // blanks it) — rendering its stand-in index would start a second copy of
    // the left slide's widgets.
    if (active && !state.missingPanes?.right) await renderLogicalSlide(state.rightSlideIndex, true);

    updateHistoryBtns();   // reflect the pane the shared undo/redo now targets
    populateSlideNavigator();
}

function updateSlideNavigator() {
    // Scoped to #slide-nav-slides: bookmark pins in #bookmark-pins share the
    // `.slide-nav-item` class (for styling) but aren't part of the slide
    // structure. Querying unscoped would shift every idx below by the pin
    // count, since pins sit earlier in the DOM — e.g. with one bookmark,
    // clicking "slide 3" would highlight/enable "slide 2" instead.
    // On a view slide's split, the view slide is the one you're on — mark it,
    // not its left pane.
    const viewIdx = state.splitView && state.currentViewIndex != null &&
                    state.slideStructure[state.currentViewIndex]?.type === 'view' ? state.currentViewIndex : null;
    const here = viewIdx ?? state.currentSlide;
    document.querySelectorAll('#slide-nav-slides .slide-nav-item').forEach((el, idx) => {
        el.classList.toggle('active',          idx === here);
        el.classList.toggle('current-slide',   idx === here);
        el.classList.toggle('bookmarked',      !!state.bookmarks[idx]);
        el.classList.toggle('type-view',        state.slideStructure[idx]?.type === 'view');
        el.classList.toggle('is-right-slide',  viewIdx == null && state.splitView && !state.missingPanes?.right && idx === state.rightSlideIndex);
        el.classList.toggle('is-hidden-slide', !!state.slideStructure[idx]?.hidden);

        const leftZone  = el.querySelector('.slide-split-zone--left');
        const rightZone = el.querySelector('.slide-split-zone--right');
        if (leftZone && rightZone) {
            // Active = this slide is currently assigned to that pane
            const miss = state.splitView ? state.missingPanes : null;
            leftZone.classList.toggle('is-active',   state.splitView && !miss?.left  && idx === state.currentSlide);
            rightZone.classList.toggle('is-active',  state.splitView && !miss?.right && idx === state.rightSlideIndex);
            // Disabled = placing this slide on that pane would duplicate across both panes
            leftZone.classList.toggle('is-disabled',  state.splitView && idx === state.rightSlideIndex && idx !== state.currentSlide);
            rightZone.classList.toggle('is-disabled', state.splitView && idx === state.currentSlide   && idx !== state.rightSlideIndex);
        }

        // Clear any legacy inline styles
        el.style.pointerEvents = '';
        el.style.opacity = '';
    });
    if (viewIdx != null) {
        document.querySelector(`#slide-nav-slides .slide-nav-item[data-index="${viewIdx}"]`)
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
}

function updateBlankSlideButtons() {
    const obj = state.slideStructure[state.currentSlide];
    const addBtn  = document.getElementById('add-blank-btn');
    const delBtn  = document.getElementById('delete-blank-btn');
    if (delBtn) {
        const deletable = isDeletableSlide(obj);
        delBtn.disabled = !deletable;
        delBtn.style.opacity = deletable ? '1' : '0.5';
        delBtn.title = obj?.type === 'pdf' ? 'Delete duplicated slide' : 'Delete blank slide';
    }
}

/* ─── slide rendering ─────────────────────────────────────────── */
function _slideOverlay(isRight) {
    const id = isRight ? 'pdf-container-2' : 'pdf-container';
    return document.getElementById(id)?.querySelector('.slide-loading-overlay') ?? null;
}

// renderLogicalSlide for one pane of the split on stage, unless that pane is
// undefined (see showViewWithUndefinedPane) — then it stays blank under its
// card instead of showing a second copy of the other pane's slide.
function renderPane(idx, isRight, suppressOverlay = false, forceRefresh = false) {
    const miss = state.splitView ? state.missingPanes : null;
    if (isRight ? miss?.right : miss?.left) { blankPane(isRight); return Promise.resolve(); }
    return renderLogicalSlide(idx, isRight, suppressOverlay, forceRefresh);
}

async function renderSplitSlides(leftIdx, rightIdx) {
    const lo = _slideOverlay(false);
    const ro = _slideOverlay(true);
    lo?.classList.add('visible');
    ro?.classList.add('visible');
    await Promise.all([
        renderPane(leftIdx,  false, true),
        renderPane(rightIdx, true,  true),
    ]);
    lo?.classList.remove('visible');
    ro?.classList.remove('visible');
}

// forceRefresh=true is passed after editor changes: widgets that are no longer
// on the slide are discarded; changed ones are rebuilt by renderWidgets.
// changes (add/remove/modify widgets) take effect on re-render.
async function renderLogicalSlide(logicalIndex, isRight = false, suppressOverlay = false, forceRefresh = false) {
    const obj = state.slideStructure[logicalIndex];
    if (!obj) return;

    // Stamp a generation token so we can detect if a newer render supersedes
    // this one before we finish (fast tab-switching race condition).
    const paneKey = isRight ? 'R' : 'L';
    const myGen = ++_renderGen[paneKey];

    const slideContainer = isRight
        ? document.getElementById('pdf-canvas-2')
        : document.getElementById('pdf-canvas');
    const annContainer = isRight
        ? document.getElementById('ann-canvas-2')
        : document.getElementById('ann-canvas');
    const cvs    = isRight ? state.pdfCvs2 : state.pdfCvs;
    const annCvs = isRight ? state.annCvs2 : state.annCvs;
    const annotsMap = state.annotations;

    if (!cvs || !annCvs) return;

    // ── Park widgets from the slide currently in this container ───────────
    // Keyed by pane + the slide's own identity, never its position: a
    // position-based key ("L3") went stale on every reorder or insert, which
    // handed one slide's parked widgets to whichever slide moved into that
    // position — where they were torn down as "not in this slide's config"
    // and the real owner had to start its widgets from scratch.
    const newSlideKey = (isRight ? 'R:' : 'L:') + slideUid(obj);
    const prevSlideKey = slideContainer?.dataset?.slideKey;
    if (slideContainer && prevSlideKey != null) {
        parkWidgets(slideContainer, prevSlideKey);
        // Remove non-widget media from the old slide
        slideContainer.querySelectorAll('video,audio,model-viewer').forEach(el => el.remove());
    }
    // After editor changes, only widgets that were removed are discarded here
    // (renderWidgets never runs for a slide left with none). Changed ones are
    // rebuilt by renderWidgets itself. Discarding everything rebooted every
    // widget on the slide each time edit mode was left — a notebook loaded twice.
    if (forceRefresh) {
        const cfgKey = configKeyOf(obj);
        const keep = new Set((state.slideConfigs[cfgKey]?.widgets || []).map(w => String(w.id)));
        discardParkedWidgets(newSlideKey, keep);
    }

    const loading = suppressOverlay ? null : _slideOverlay(isRight);
    if (loading) loading.classList.add('visible');

    // A blank slide's paper (lined, grid, dots) is the container's own
    // background; a PDF page covers the container, so clear it there.
    applyPaper(slideContainer, obj.type === 'blank' ? obj.paper : null);

    if (obj.type === 'pdf') {
        if (cvs.canvas) cvs.canvas.style.visibility = 'visible';
        if (annContainer) annContainer.style.background = '';
        await renderPdfSlide(obj.pdfIndex, logicalIndex, isRight, newSlideKey);
    } else if (obj.type === 'blank') {
        if (cvs.canvas) cvs.canvas.style.visibility = 'hidden';
        annCvs.clear();
        if (annotsMap[logicalIndex]) {
            await annCvs.loadAnnotations(annotsMap[logicalIndex]);
        } else {
            annCvs.resetHistory?.();
        }
        if (annContainer) annContainer.style.background = '';
        if (obj.blankId) {
            const blankCfg = await loadBlankConfig(obj.blankId);
            if (blankCfg && slideContainer) {
                const rect = slideContainer.getBoundingClientRect();
                await renderMedia(blankCfg, slideContainer, rect, isRight, newSlideKey);
            }
        }
    }

    // Reveal-step covers and "appear on step" media, for whichever slide is
    // now showing in this pane.
    if (myGen === _renderGen[paneKey]) renderReveals(slideContainer, obj, newSlideKey);

    // Only record which slide this container is showing if this render is
    // still the latest one for this pane — a faster later render may have
    // already written a newer key, and we must not overwrite it.
    if (myGen === _renderGen[paneKey] && slideContainer) {
        slideContainer.dataset.slideKey = newSlideKey;
    }

    if (loading) loading.classList.remove('visible');
    updateHistoryBtns();
}

async function renderPdfSlide(pdfIndex, logicalIndex, isRight = false, slideKey = null) {
    if (!state.zipFile) return;

    const pdfDoc = await getPdfDoc();
    if (!pdfDoc) { console.error('No slides.pdf in ZIP'); return; }
    const page = await pdfDoc.getPage(pdfIndex + 1);

    // Bail out if the slide at this logical index has changed (e.g. a blank
    // was inserted here) or if the user navigated away while we were loading.
    const latestObj = state.slideStructure[logicalIndex];
    if (!isRight && (!latestObj || latestObj.type !== 'pdf' || latestObj.pdfIndex !== pdfIndex || state.currentSlide !== logicalIndex)) return;

    const cvs    = isRight ? state.pdfCvs2 : state.pdfCvs;
    const annCvs = isRight ? state.annCvs2 : state.annCvs;
    const annotsMap = state.annotations;
    const container = isRight
        ? document.getElementById('pdf-canvas-2')
        : document.getElementById('pdf-canvas');

    await cvs.renderPDFPage(page);

    annCvs.clear();
    if (annotsMap[logicalIndex ?? state.currentSlide]) {
        await annCvs.loadAnnotations(annotsMap[logicalIndex ?? state.currentSlide]);
    } else {
        annCvs.resetHistory?.();
    }

    // A duplicated page shows the same PDF page but has its own config.
    const cfgId = state.slideStructure[logicalIndex]?.cfgId;
    const config = cfgId ? await loadBlankConfig(cfgId) : await loadSlideConfig(pdfIndex);
    if (!config) return;

    const rect = container.getBoundingClientRect();
    await renderMedia(config, container, rect, isRight, slideKey);
}

/* ─── slide config / media cache ─────────────────────────────── */

async function loadSlideConfig(pdfIndex) {
    if (state.slideConfigs[pdfIndex]) return state.slideConfigs[pdfIndex];
    try {
        const f = state.zipFile.file(`config/s${pdfIndex}.json`);
        if (!f) return null;
        state.slideConfigs[pdfIndex] = JSON.parse(await f.async('string'));
    } catch (e) { state.slideConfigs[pdfIndex] = null; }
    return state.slideConfigs[pdfIndex];
}

// Load config for a blank slide (keyed by blankId string).
// In-session the config lives in state.slideConfigs[blankId]; after save+reload
// it is read from config/s<blankId>.json inside the ZIP.
async function loadBlankConfig(blankId) {
    if (state.slideConfigs[blankId] !== undefined) return state.slideConfigs[blankId] || null;
    try {
        const f = state.zipFile?.file(`config/s${blankId}.json`);
        if (!f) { state.slideConfigs[blankId] = null; return null; }
        state.slideConfigs[blankId] = JSON.parse(await f.async('string'));
    } catch { state.slideConfigs[blankId] = null; }
    return state.slideConfigs[blankId];
}

// Parse slides.pdf once per presentation and reuse the PDFDocument for every
// slide render and for thumbnail generation. We memoize the *promise* (not just
// the resolved doc) so the parallel left/right renders in split view share a
// single parse instead of each decoding the whole file. Reset to null whenever
// a new presentation is loaded.
function getPdfDoc() {
    if (state._pdfDocPromise) return state._pdfDocPromise;
    const pdfFile = state.zipFile?.file('slides.pdf');
    if (!pdfFile) return Promise.resolve(null);
    state._pdfDocPromise = pdfFile.async('arraybuffer')
        .then(data => pdfjsLib.getDocument({ data }).promise);
    return state._pdfDocPromise;
}

/* ─── annotation persistence ──────────────────────────────────── */
// Stash the current canvas into state.annotations so strokes survive
// navigating away and back (and get bundled into the saved ZIP).
let annotationSyncTimer = null;
function syncAnnotations() {
    clearTimeout(annotationSyncTimer);
    const cvs = activeAnnCvs();
    // Remember the slide, not its position: if the deck is reordered (or a
    // slide inserted) inside the debounce window, the old position belongs
    // to a different slide by the time this fires.
    const slide = state.slideStructure[activeAnnSlide()];
    annotationSyncTimer = setTimeout(() => {
        const idx = state.slideStructure.indexOf(slide);
        if (idx >= 0) state.annotations[idx] = cvs.canvas.toDataURL('image/png');
    }, 100);
}

function saveCurrentAnnotations() {
    clearTimeout(annotationSyncTimer);
    if (!state.annCvs) return;
    // Use the last committed snapshot, not the live canvas: split/layout
    // transitions call resizeOnly() which blanks the live bitmap before the
    // re-render reloads it. Reading the live canvas in that window would persist
    // a blank over the real annotation (this is what made annotations vanish
    // when entering/leaving an auto split-view).
    // An undefined pane has no slide of its own: its (blank) canvas must not
    // be written over the real slide its index stands in for.
    const missing = state.splitView ? state.missingPanes : null;
    if (!missing?.left) state.annotations[state.currentSlide] = state.annCvs.getCommittedSnapshot();
    // Also save the right pane when in split view
    if (state.splitView && state.annCvs2 && !missing?.right) {
        state.annotations[state.rightSlideIndex] = state.annCvs2.getCommittedSnapshot();
    }
}

/* ─── empty stage placeholder ─────────────────────────────────── */
// Controls that only mean anything once the deck holds at least one slide:
// split view, save/download, bookmark, edit mode, and the whole annotation
// toolbar (tools, pen slots, undo/redo, clear). Disabling the buttons also
// covers the keyboard shortcuts, which fire by clicking them — a disabled
// button ignores .click().
// Upload and "insert blank slide" stay live: they are how you leave the empty
// state. Pen slots are built once by initPenSlots() during bootstrap, so they
// are already in the DOM the first time this runs.
const STAGE_CONTROL_SELECTOR = [
    '#split-toggle',
    '#mute-btn',
    '#duplicate-slide-btn',
    '#edit-save-btn',
    '#bookmark-btn',
    '#floating-annotation-toolbar button',
].join(', ');

function setStageControlsEnabled(enabled) {
    document.querySelectorAll(STAGE_CONTROL_SELECTOR).forEach(el => { el.disabled = !enabled; });

    // Edit mode is handled apart from the list above because the same button
    // doubles as "exit edit mode": disabling it while edit mode is on — say the
    // user deletes the last slide from inside the editor — would trap them
    // there.
    const editBtn = document.getElementById('edit-mode-btn');
    if (editBtn && !state.editMode) editBtn.disabled = !enabled;

    if (!enabled) return;
    // Split view needs two real slides to show side by side. Leaving split
    // view must always stay possible, so only the way in is blocked.
    const splitBtn = document.getElementById('split-toggle');
    if (splitBtn && !state.splitView) {
        const tooFew = realSlideCount(state.slideStructure) < 2;
        splitBtn.disabled = tooFew;
        splitBtn.title = tooFew ? 'Split view needs at least two slides' : 'Split view';
    }
    // Undo/redo have their own enabled rule (does the active canvas have
    // history?) — hand them back to it rather than force-enabling them.
    updateHistoryBtns();
}

// Shown only while the deck holds no slides at all (fresh session before any
// upload, or after the last blank slide is deleted). Called from
// populateSlideNavigator(), which every structure change funnels through.
function updateStageEmptyState() {
    const el = document.getElementById('stage-empty');
    if (!el) return;
    const isEmpty = state.slideStructure.length === 0;
    el.hidden = !isEmpty;
    setStageControlsEnabled(!isEmpty);
    if (isEmpty) toggleMute(false);   // nothing left to hide
    if (!isEmpty) return;
    // Nothing behind the placeholder: drop any ink and hide the slide bitmap
    // left over from a deck that has just been emptied. The non-empty case is
    // left alone — renderLogicalSlide() owns canvas visibility from there on
    // (it keeps the bitmap hidden for blank slides).
    state.annCvs?.clear();
    state.annCvs?.resetHistory?.();
    if (state.pdfCvs?.canvas) state.pdfCvs.canvas.style.visibility = 'hidden';
}

/* ─── populate slide navigator ────────────────────────────────── */
function populateSlideNavigator() {
    const labels = getSlideLabels(state.slideStructure);
    bus.emit('slides:loaded', state.slideStructure.map((obj, i) => {
        const base = {
            kind:     obj.type,
            label:    labels[i],
            title:    obj.type === 'blank' ? labels[i] : `Slide ${labels[i]}`,
            customTitle: typeof obj.title === 'string' ? obj.title : '',
            paper:    obj.type === 'blank' ? (obj.paper || null) : null,
            thumbUrl: obj.type === 'pdf'   ? (state.slideThumbnailCache[obj.pdfIndex] ?? null) : null,
        };
        if (obj.type === 'view') {
            const L = validPane(obj.left), R = validPane(obj.right);
            base.viewLeft      = L;
            base.viewRight     = R;
            base.viewRatio     = obj.ratio ?? 50;
            // "?" for a pane whose slide was deleted (or never chosen).
            base.viewLeftLabel  = L != null ? labels[L] : '?';
            base.viewRightLabel = R != null ? labels[R] : '?';
            base.viewLeftMissing  = L == null;
            base.viewRightMissing = R == null;
        }
        return base;
    }));
    updateSlideNavigator();
    updateStageEmptyState();
    updateStepBadge();
    // Pins show each slide's title/thumbnail too, so they follow any change.
    populateBookmarkPins();
}

// The editor changed a blank slide's paper: repaint the pane(s) showing it.
bus.on('paper:changed', () => {
    const left  = state.slideStructure[state.currentSlide];
    const right = state.splitView ? state.slideStructure[state.rightSlideIndex] : null;
    if (left?.type === 'blank')  applyPaper(document.getElementById('pdf-canvas'), left.paper);
    if (right?.type === 'blank') applyPaper(document.getElementById('pdf-canvas-2'), right.paper);
    populateSlideNavigator();
});

bus.on('nav:refresh', () => populateSlideNavigator());
// Duplicating a slide copies its annotations — commit what's on stage first.
bus.on('annotations:flush', () => saveCurrentAnnotations());

// Live divider-position preview while the slider is being dragged.
// Only adjusts CSS flex proportions — does NOT resize canvas pixel dimensions,
// so the existing rendered slide content stays visible (stretched slightly by CSS).
bus.on('view:set-ratio', (ratio) => {
    if (!state.splitView) return;
    applySplitRatio(ratio);
    updateWidgetPositions(document.getElementById('pdf-canvas'));
    updateWidgetPositions(document.getElementById('pdf-canvas-2'));
    updateMediaPositions(document.getElementById('pdf-canvas'));
    updateMediaPositions(document.getElementById('pdf-canvas-2'));
});

// Full resize + re-render committed when the slider is released.
bus.on('view:ratio-commit', async (ratio) => {
    if (!state.splitView) return;
    applySplitRatio(ratio);
    sizeSlideCanvases();
    state.annCvs.resizeOnly?.();
    state.annCvs2?.resizeOnly?.();
    state.pdfCvs.resizeOnly?.();
    state.pdfCvs2?.resizeOnly?.();
    await renderSplitSlides(state.currentSlide, state.rightSlideIndex);
    updateWidgetPositions(document.getElementById('pdf-canvas'));
    updateWidgetPositions(document.getElementById('pdf-canvas-2'));
    updateMediaPositions(document.getElementById('pdf-canvas'));
    updateMediaPositions(document.getElementById('pdf-canvas-2'));
    bus.emit('split:resized');
});

function populateBookmarkPins() {
    const pins = document.getElementById('bookmark-pins');
    if (!pins) return;
    pins.innerHTML = '';
    const indices = Object.keys(state.bookmarks).map(Number).filter(i => i >= 0 && i < state.slideStructure.length).sort((a, b) => a - b);
    pins.style.display = indices.length ? 'flex' : 'none';
    const labels = getSlideLabels(state.slideStructure);
    indices.forEach(i => {
        const item = document.createElement('div');
        item.className = 'slide-nav-item bookmarked';
        const obj = state.slideStructure[i];
        if (obj?.type === 'blank') item.classList.add('slide-nav-child');
        const preview = document.createElement('div');
        preview.className = 'slide-preview bookmark-preview';
        const lbl = labels[i] || String(i + 1);
        preview.dataset.slideNumber = lbl;
        item.dataset.label = lbl;
        // Thumbnail cache is keyed by pdfIndex, not structure index — once
        // blank/view slides exist the two diverge.
        const thumb = obj?.type === 'pdf' ? state.slideThumbnailCache[obj.pdfIndex] : null;
        if (obj?.title) {
            preview.classList.add('slide-preview--titled');
            const t = document.createElement('span'); t.className = 'slide-preview-title'; t.textContent = obj.title; preview.appendChild(t);
        } else if (thumb) {
            const img = document.createElement('img'); img.src = thumb; preview.appendChild(img);
        } else {
            const span = document.createElement('span'); span.textContent = `Slide ${lbl}`; preview.appendChild(span);
            if (obj?.type === 'blank') applyPaper(preview, obj.paper, { thumb: true });
        }
        item.appendChild(preview);
        item.addEventListener('click', () => goToSlide(i));
        pins.appendChild(item);
    });
}

/* ─── slide-canvas sizing ─────────────────────────────────────── */
/**
 * Compute a pixel-exact 4:3 size fitting within 95 % of each slide
 * container and apply it as inline styles to the canvas wrapper divs,
 * their annotation overlays, and the loading-overlay elements.
 *
 * Called on init, window resize, focus-mode toggle, and split-view
 * toggle so the ratio is always correct on every device / orientation.
 */
function sizeSlideCanvases() {
    const pairs = [
        ['pdf-container',   'pdf-canvas',   'ann-canvas'],
        ['pdf-container-2', 'pdf-canvas-2', 'ann-canvas-2'],
    ];
    for (const [containerId, cvId, annId] of pairs) {
        const pane = document.getElementById(containerId);
        const cv   = document.getElementById(cvId);
        const ann  = document.getElementById(annId);
        if (!pane || !cv) continue;
        const availW = pane.clientWidth  * 0.95;
        const availH = pane.clientHeight * 0.95;
        if (!availW || !availH) continue;
        let w, h;
        if (availW / availH >= 4 / 3) {
            h = availH; w = h * 4 / 3;   // height is the binding axis
        } else {
            w = availW; h = w * 3 / 4;   // width is the binding axis
        }
        cv.style.width  = `${w}px`;
        cv.style.height = `${h}px`;
        if (ann) { ann.style.width = `${w}px`; ann.style.height = `${h}px`; }
        const overlay = pane.querySelector('.slide-loading-overlay');
        if (overlay) { overlay.style.width = `${w}px`; overlay.style.height = `${h}px`; }
        const empty = pane.querySelector('.stage-empty');
        if (empty) { empty.style.width = `${w}px`; empty.style.height = `${h}px`; }
        const undef = pane.querySelector('.pane-undefined');
        if (undef) { undef.style.width = `${w}px`; undef.style.height = `${h}px`; }
    }
}

/* ─── resize / fullscreen ─────────────────────────────────────── */
// Reposition widgets AND media overlays in both panes after any layout change.
function _updateAllOverlayPositions() {
    if (!state.zipFile) return;
    const left = document.getElementById('pdf-canvas');
    updateWidgetPositions(left);
    updateMediaPositions(left);
    if (state.splitView) {
        const right = document.getElementById('pdf-canvas-2');
        updateWidgetPositions(right);
        updateMediaPositions(right);
    }
}

function wireResizeAndFullscreen() {
    window.addEventListener('resize', () => {
        sizeSlideCanvases();
        state.annCvs?.resize?.();
        if (state.splitView) state.annCvs2?.resize?.();
        if (state.splitView) applySplitRatio(state.splitRatio);
        _updateAllOverlayPositions();
    });
    document.addEventListener('fullscreenchange', () => {
        setTimeout(() => {
            sizeSlideCanvases();
            state.annCvs?.resize?.();
            if (state.splitView) applySplitRatio(state.splitRatio);
            _updateAllOverlayPositions();
            renderSpotlight();
        }, 100);
    });
}

/* ─── editor: exit → re-render so added media appears immediately */
bus.on('editor:exited', async () => {
    await renderPane(state.currentSlide, false, false, true);
    updateStepBadge();   // reveal steps may have been added or removed
});

/* ─── editor: slide reorder ───────────────────────────────────── */
bus.on('slides:reordered', async () => {
    // Every position-keyed map has already been remapped (remapSlideIndices),
    // and widgets are keyed by slide identity, so there is nothing to throw
    // away: each widget, visible or parked, keeps its live state. (This used
    // to call clearAllParked(), which rebooted every widget in the deck and
    // also dropped the widget states loaded from the ZIP.)
    //
    // The slide(s) on stage are the same slides as before, just at new
    // positions. Re-render them quietly anyway — an in-flight render that
    // started under the old numbering would otherwise bail out half-done —
    // after first committing the canvas so the re-render reloads the latest
    // strokes rather than an older snapshot.
    saveCurrentAnnotations();
    populateSlideNavigator();
    if (state.splitView) {
        await Promise.all([
            renderPane(state.currentSlide,    false, true),
            renderPane(state.rightSlideIndex, true,  true),
        ]);
    } else {
        await renderLogicalSlide(state.currentSlide, false, true);
    }
    updateSlideNavigator();
    updateBlankSlideButtons();
});

/* ─── thumbnail generation ────────────────────────────────────── */
async function generateThumbnails() {
    if (!state.zipFile) return;
    const pdfDoc = await getPdfDoc();
    if (!pdfDoc) return;

    for (let i = 0; i < pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i + 1);
        const viewport = page.getViewport({ scale: 0.5 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        state.slideThumbnailCache[i] = canvas.toDataURL();
    }
    populateSlideNavigator();
}

/* ─── upload (public) ─────────────────────────────────────────── */
export async function loadZipPresentation(file) {
    const modal = window.BeamerModal;
    modal?.show({ kind: 'loading', title: 'Loading…', message: 'Parsing presentation…' });

    try {
        const data = await readUserFileBytes(file);
        const zip  = await JSZip.loadAsync(data);
        const pdfFile = zip.file('slides.pdf');
        if (!pdfFile) throw new Error('ZIP must contain slides.pdf');

        const pdfData = await pdfFile.async('arraybuffer');
        const pdfDoc  = await pdfjsLib.getDocument({ data: pdfData }).promise;
        const total   = pdfDoc.numPages;

        // Restore saved slide order written by the editor (if present)
        let slideStructure = Array.from({ length: total }, (_, i) => ({ type: 'pdf', pdfIndex: i }));
        const orderFile = zip.file('config/slide-order.json');
        if (orderFile) {
            try {
                const saved = JSON.parse(await orderFile.async('string'));
                if (Array.isArray(saved) && saved.length > 0) slideStructure = saved;
            } catch (_) {}
        }

        // Destroy all pooled widgets from any previous presentation
        clearAllParked();
        const leftCvs = document.getElementById('pdf-canvas');
        const rightCvs = document.getElementById('pdf-canvas-2');
        if (leftCvs)  delete leftCvs.dataset.slideKey;
        if (rightCvs) delete rightCvs.dataset.slideKey;

        state.zipFile        = zip;
        state.deckName       = deckNameOf(file);
        // Free the previous PDF's worker memory, then reuse the document we
        // just parsed instead of decoding it again on first render.
        state._pdfDocPromise?.then(d => d?.destroy?.()).catch(() => {});
        state._pdfDocPromise = Promise.resolve(pdfDoc);
        state.totalSlides    = slideStructure.length;
        state.slideStructure = slideStructure;
        state.currentSlide   = 0;
        state.slideConfigs   = {}; resetMediaCache();
        state.annotations    = {};
        resetAllTextBoxes(state);
        state.bookmarks      = {};
        if (state.editorNewFiles) state.editorNewFiles = {};

        // Restore saved annotations (persistent pen strokes across re-uploads).
        const annotFile = zip.file('config/annotations.json');
        if (annotFile) {
            try {
                const saved = JSON.parse(await annotFile.async('string'));
                if (saved && typeof saved === 'object') state.annotations = saved;
            } catch (_) {}
        }

        // Restore saved widget states (so widgets resume where they left off).
        const wsFile = zip.file('config/widget-states.json');
        if (wsFile) {
            try {
                const saved = JSON.parse(await wsFile.async('string'));
                if (saved && typeof saved === 'object') setWidgetStates(saved);
            } catch (_) {}
        }

        await renderLogicalSlide(0);
        await generateThumbnails();
        populateSlideNavigator();
        updateBlankSlideButtons();

        modal?.close();
        enableControls();
    } catch (err) {
        console.error('ZIP load error:', err);
        modal?.close();
        window.BeamerModal?.show({ kind: 'error', title: 'Upload failed', message: err.message });
    }
}

export async function loadPdfPresentation(file) {
    const modal = window.BeamerModal;
    modal?.show({ kind: 'loading', title: 'Loading…', message: 'Parsing PDF…' });

    try {
        const data   = await readUserFileBytes(file);
        // Hand pdf.js a copy: v4 transfers the buffer to its worker, which
        // detaches it, and we still need `data` for the ZIP below.
        const pdfDoc = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
        const total  = pdfDoc.numPages;

        const zip = new JSZip();
        zip.file('slides.pdf', data);

        // Same teardown as a ZIP load: the previous deck's widgets (visible
        // or parked) belong to slides that no longer exist.
        clearAllParked();
        for (const id of ['pdf-canvas', 'pdf-canvas-2']) {
            const el = document.getElementById(id);
            if (el) delete el.dataset.slideKey;
        }

        state.zipFile = zip;
        state.deckName = deckNameOf(file);
        // Free the previous PDF's worker memory, then reuse the document we
        // just parsed instead of decoding it again on first render.
        state._pdfDocPromise?.then(d => d?.destroy?.()).catch(() => {});
        state._pdfDocPromise = Promise.resolve(pdfDoc);
        state.totalSlides = total;
        state.slideStructure = Array.from({ length: total }, (_, i) => ({ type: 'pdf', pdfIndex: i }));
        state.currentSlide   = 0;
        state.slideConfigs   = {}; resetMediaCache();
        state.annotations    = {};
        resetAllTextBoxes(state);
        state.bookmarks      = {};
        if (state.editorNewFiles) state.editorNewFiles = {};

        await renderLogicalSlide(0);
        await generateThumbnails();
        populateSlideNavigator();
        updateBlankSlideButtons();
        modal?.close();
        enableControls();
    } catch (err) {
        console.error('PDF load error:', err);
        modal?.close();
        window.BeamerModal?.show({ kind: 'error', title: 'Upload failed', message: err.message });
    }
}

function enableControls() {
    const els = document.querySelectorAll('.controls-disable-before-load');
    els.forEach(el => { el.disabled = false; el.style.opacity = '1'; el.style.pointerEvents = 'auto'; });
}
