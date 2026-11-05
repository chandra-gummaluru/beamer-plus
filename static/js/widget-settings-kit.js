// Beamer+ widget settings kit — runs INSIDE each widget iframe.
//
// Every widget is self-contained: its own settings are the widget's business.
// A widget that has any declares "inlineEdit": true in its schema; the kit
// then puts an Edit button in its top bar (or, laid over part of a slide with
// no bar, a pencil in its corner) that switches the widget into edit mode,
// where the widget's own content becomes the form and each change is saved
// with BeamerWidget.edit.set(). Beamer+ edits only what every widget shares —
// its name, text size and place on the slide — never the widget's settings.
//
// The kit also provides the rest of the host contract: the shared top bar,
// the server origin, presentation scale, saving files into the deck, printing
// into the notes PDF.
//
// This file is injected into every widget iframe (see iframe-widget-renderer.js),
// right after window.WIDGET_CONFIG. It reads the widget's OWN schema block —
//
//   <script id="widget-schema" type="application/json">
//   { "label": "Timer", "inlineEdit": true, "modes": ["full", "overlay"] }
//   </script>
//
// — for its label, how it can be shown, and whether it can be edited.
(function () {
    'use strict';
    if (window.__beamerWidgetSettings) return;
    window.__beamerWidgetSettings = true;

    // Keys the layout system owns — a widget never edits these about itself.
    // The parent enforces the same list; edit.set() drops them too.
    var RESERVED = [
        'id', 'type', 'x', 'y', 'width', 'height', 'zIndex', 'step', 'display',
        'builtin', 'src', 'interactive',
        'notebookContent', 'role', 'socketUrl',
        'sessionId', 'serverUrl', 'publicBaseUrl',
    ];

    /* ─── schema ────────────────────────────────────────────────── */

    // This script is injected at the TOP of <head> — before the widget's own
    // <script id="widget-schema"> has been parsed — so the schema cannot be
    // read at load time. It is read on first use instead.
    var schema = null;
    var _schemaRead = false;

    // Returns false while the document is still parsing and the schema element
    // hasn't appeared yet — callers should try again once it has.
    function readSchema() {
        if (_schemaRead) return true;
        var el = document.getElementById('widget-schema');
        if (!el && document.readyState === 'loading') return false;
        _schemaRead = true;
        try { schema = el ? JSON.parse(el.textContent.trim()) : null; }
        catch (e) { schema = null; }
        return true;
    }

    function cfg() { return window.WIDGET_CONFIG || (window.WIDGET_CONFIG = {}); }

    function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

    var PENCIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';

    /**
     * The origin to talk to the Beamer+ server on — for socket.io, fetch, or
     * anything else leaving the widget.
     *
     * A widget must never call io() or fetch a root-relative URL bare: inside a
     * srcdoc iframe `location` is about:srcdoc, so location.origin is the string
     * "null" and socket.io resolves a missing URL to http://about/socket.io/ —
     * which an HTTPS deck then blocks as mixed content.
     */
    function serverOrigin() {
        var c = cfg();
        if (c.socketUrl) return c.socketUrl;
        if (c.serverUrl) return c.serverUrl;
        try {
            var po = parent && parent.location && parent.location.origin;
            if (po && po !== 'null') return po;
        } catch (e) {}
        return (location.origin && location.origin !== 'null') ? location.origin : '';
    }

    /* ─── presentation scale ────────────────────────────────────── */
    // Every widget gets the room-size control (the top bar's stepper):
    // whatever the presenter picks is applied to --u, which the shared base
    // stylesheet uses to size everything the audience has to read. Chrome
    // stays fixed, so the furniture doesn't inflate with the content.

    // The presentation scale in force: what the presenter set, else the
    // widget's own default (its schema's "scale"), else the base stylesheet's.
    function currentScale() {
        if (!readSchema()) return 1.4;
        var raw = cfg().scale !== undefined ? cfg().scale : (schema ? schema.scale : undefined);
        var v = parseFloat(raw);
        return (!isNaN(v) && v > 0) ? v : 1.4;
    }

    function applyScale() {
        if (!readSchema()) return;
        document.documentElement.style.setProperty('--u', String(currentScale()));
    }
    /**
     * The base for Beamer+ API calls: the origin PLUS this session's /s/<code>
     * prefix. Every asset and survey route lives under that prefix, so a widget
     * that builds an API URL from serverOrigin() (which is the bare origin, for
     * socket.io) gets a 404. Use this for fetch, that for io().
     */
    function serverUrl() {
        var c = cfg();
        return (c.serverUrl || c.publicBaseUrl || serverOrigin() || '').replace(/\/+$/, '');
    }

    function post(msg) { try { parent.postMessage(msg, '*'); } catch (e) {} }
    /* ─── files ─────────────────────────────────────────────────── */
    // The widget can't reach the editor's pending-files map, so the bytes go
    // to the parent, which stores them for the save ZIP, uploads them so the
    // widget can read the file before the deck is saved, and replies with the
    // path to record.

    // key → resolve callback for an upload in flight. One per key is plenty:
    // a second save of the same key supersedes the first.
    var _pendingAssets = {};

    /**
     * Save a file into the deck. The bytes go into the presentation ZIP under
     * <folder>/<name> and the path is written to this widget's config under
     * <key>, so the file is there again next time the deck is opened — which is
     * where a file belongs, rather than inlined into the widget's state.
     *
     * opts: { key, name, buffer, folder = 'files', serve = true }
     * serve:false skips the immediate upload, for a widget that already holds
     * the content and doesn't need to read it back over HTTP.
     * Resolves with the saved path.
     */
    function saveFile(opts) {
        opts = opts || {};
        if (!opts.key || !opts.buffer) return Promise.reject(new Error('saveFile needs a key and a buffer'));
        return new Promise(function (resolve, reject) {
            _pendingAssets[opts.key] = { resolve: resolve, reject: reject };
            post({
                type:     'widget-asset-upload',
                widgetId: cfg().id,
                key:      opts.key,
                folder:   opts.folder || 'files',
                name:     opts.name || 'file',
                serve:    opts.serve !== false,
                buffer:   opts.buffer,
            });
        });
    }

    function onAssetSaved(msg) {
        var p = _pendingAssets[msg.key];
        if (!p) return;
        delete _pendingAssets[msg.key];
        // Keep our own config in step, so a re-read sees the new path.
        if (msg.path) cfg()[msg.key] = msg.path;
        p.resolve(msg.path || '');
    }

    // Widgets that own a file register here; Beamer+ asks just before it builds
    // the ZIP, so an edit made during the talk is written back rather than only
    // the version originally opened.
    var _flushHandler = null;

    function onFlushFiles(fn) { _flushHandler = typeof fn === 'function' ? fn : null; }

    var selfDispatch = false;   // our own re-broadcast of widget-config (edit.set)

    /* ─── edit mode (editing on the widget itself) ──────────────── */
    // A widget that declares "inlineEdit": true in its schema is set up on the
    // widget itself: the Edit button (top right of the bar, or the corner
    // pencil on an overlay) puts it into edit mode, body.bw-editing, where its
    // own content becomes the form — the question is typed where the question
    // shows, a timer's digits are the duration, a table's cells are its
    // starting data. Done (or Escape) leaves it.
    //
    // The widget does the drawing; the kit only:
    //   - toggles body.bw-editing and fires the window event 'bw-edit'
    //     { detail: { editing } } — the widget listens and redraws;
    //   - stores changes: BeamerWidget.edit.set(patch, remove) merges them into
    //     the config, sends them to Beamer+ (which saves them with the slide) and
    //     hands the widget its new config as an ordinary 'widget-config'
    //     message — unless { silent: true }, for a widget that already shows it;
    //   - grows an overlay or inset to the full slide while it is edited (there
    //     is no room to edit a corner clock in its corner) and puts it back after;
    //   - makes the Name (the bar's title, hidden otherwise) editable in place.
    //
    // Opened as a file, outside Beamer+, edit mode works the same; changes
    // simply stay with the page until it is reloaded.
    //
    // A widget without "inlineEdit" has nothing to set up (whatever it holds
    // — code, a circuit, a sum — is written on it directly): no Edit button.

    var editing = false, editGrew = false;

    function inlineEdit() { return readSchema() && !!(schema && schema.inlineEdit); }
    function hosted() {
        try { return window.parent !== window && cfg().id != null; } catch (e) { return false; }
    }
    function canEdit() {
        if (cfg().role === 'viewer' || window.BEAMER_PRINT || cfg().printMode) return false;
        return inlineEdit();
    }

    function editSet(patch, remove, opts) {
        if (remove && !Array.isArray(remove)) { opts = remove; remove = []; }
        patch = patch || {}; remove = remove || []; opts = opts || {};
        var c = cfg();
        remove.forEach(function (k) { delete c[k]; });
        Object.keys(patch).forEach(function (k) {
            if (RESERVED.indexOf(k) === -1) c[k] = patch[k];
        });
        if (hosted()) post({ type: 'widget-settings', widgetId: c.id, patch: patch, remove: remove });
        if ('title' in patch || remove.indexOf('title') >= 0) syncTitle();
        if ('scale' in patch) { applyScale(); syncScaleButtons(); }
        if (opts.silent) return;
        selfDispatch = true;
        try { window.dispatchEvent(new MessageEvent('message', { data: { type: 'widget-config', config: c, live: true } })); }
        catch (e) {}
        selfDispatch = false;
    }

    function syncTitle() {
        if (!titleEl) return;
        if (editing && document.activeElement === titleEl) return;   // being typed into
        titleEl.textContent = editing ? customName() : barTitle();
    }

    var editBtn = null, floatEdit = null;
    var PENCIL_SM = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
    var CHECK_SM  = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

    function paintEditButtons() {
        if (editBtn) {
            editBtn.innerHTML = (editing ? CHECK_SM : PENCIL_SM) + '<span>' + (editing ? 'Done' : 'Edit') + '</span>';
            editBtn.classList.toggle('bw-btn--primary', editing);
            editBtn.title = editing ? 'Done editing (Esc)' : 'Edit this widget';
            editBtn.setAttribute('aria-pressed', editing ? 'true' : 'false');
        }
        if (floatEdit) floatEdit.title = editing ? 'Done editing' : 'Edit this widget';
    }

    function onEditButton() {
        if (editing) exitEdit(); else enterEdit();
    }

    function enterEdit() {
        if (editing || !canEdit()) return;
        editing = true;
        // An overlay or an inset is too small to edit in place: grow it to the
        // slide and show the full widget, with its bar, while it is edited.
        editGrew = displayMode() === 'overlay' || isPartial();
        if (editGrew) post({ type: 'widget-expand', widgetId: cfg().id });
        document.body.classList.add('bw-editing');
        if (titleEl) {
            titleEl.setAttribute('contenteditable', 'plaintext-only');
            if (titleEl.contentEditable !== 'plaintext-only') titleEl.setAttribute('contenteditable', 'true');
            titleEl.setAttribute('data-bw-placeholder', (schema && schema.label) || 'Name');
            titleEl.setAttribute('spellcheck', 'false');
            titleEl.title = 'Name';
        }
        syncTitle();
        syncLayoutMode();
        paintEditButtons();
        document.addEventListener('keydown', onEditKey, true);
        // The host stops taking dropped files (as a new deck) while a widget
        // is edited, so a file dropped on the widget reaches the widget.
        post({ type: 'widget-editing', widgetId: cfg().id, on: true });
        fire(true);
    }

    function exitEdit() {
        if (!editing) return;
        if (document.activeElement && document.activeElement !== document.body) {
            try { document.activeElement.blur(); } catch (e) {}
        }
        editing = false;
        document.body.classList.remove('bw-editing');
        if (titleEl) {
            titleEl.removeAttribute('contenteditable');
            titleEl.removeAttribute('title');
        }
        document.removeEventListener('keydown', onEditKey, true);
        if (editGrew) post({ type: 'widget-collapse', widgetId: cfg().id });
        editGrew = false;
        syncTitle();
        syncLayoutMode();
        paintEditButtons();
        post({ type: 'widget-editing', widgetId: cfg().id, on: false });
        fire(false);
    }

    function fire(on) {
        try { window.dispatchEvent(new CustomEvent('bw-edit', { detail: { editing: on } })); } catch (e) {}
    }

    // Escape first leaves whatever is being typed into, then edit mode. A
    // widget with a popup of its own open calls preventDefault() to keep it.
    function onEditKey(e) {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        var a = document.activeElement;
        setTimeout(function () {
            if (e.defaultPrevented || !editing) return;
            if (a && a !== document.body && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) {
                a.blur();
                return;
            }
            exitEdit();
        }, 0);
    }

    function wireTitleEditing() {
        if (!titleEl || titleEl.__bwWired) return;
        titleEl.__bwWired = true;
        titleEl.addEventListener('input', function () {
            if (!editing) return;
            var v = titleEl.textContent.replace(/\s+/g, ' ').trim();
            if (v) editSet({ title: v }, [], { silent: true });
            else editSet({}, ['title', 'downloadName'], { silent: true });
        });
        titleEl.addEventListener('keydown', function (e) {
            if (editing && e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
        });
        titleEl.addEventListener('blur', function () { if (editing) syncTitle(); });
    }

    var editApi = {
        /** Can this copy be edited at all (presenter, not a print copy)? */
        available: function () { return canEdit(); },
        /** Is the widget in edit mode now? */
        get active() { return editing; },
        isActive: function () { return editing; },
        enter: enterEdit,
        exit: exitEdit,
        /**
         * Change settings from the widget: set(patch, remove?, { silent? }).
         * Saved with the slide inside Beamer+, kept until reload outside it.
         */
        set: editSet,
    };

    /* ─── top bar ───────────────────────────────────────────────── */
    // Every widget carries the same bar, built here rather than in each widget:
    // the title, whatever controls the widget registers, and the shared
    // utilities. The widget's own markup is moved into .bw-topbar-body beneath
    // it, so a widget never has to leave room for the bar or know it exists.
    //
    // A widget opts out with "topbar": false in its schema (for one that is
    // nothing but an embedded frame), and hides the font stepper alone with
    // "fontSize": false (for one whose content it cannot reach — a remote page,
    // a video, a map).

    // Coarse enough that one press is visibly different from the back of a room.
    var SCALE_STEPS = [1, 1.2, 1.4, 1.7, 2, 2.4];

    var barEl = null, actionsEl = null, titleEl = null, resetHandler = null;

    /* ─── name ──────────────────────────────────────────────────── */
    // One Name per widget, used everywhere it shows up: the bar title, the
    // heading inside an exported PDF, and every file the widget downloads.
    // Blank means the widget's own default. `downloadName` is read as a
    // fallback for decks saved while that was a separate setting.

    function customName() {
        var c = cfg();
        if (typeof c.title === 'string' && c.title.trim()) return c.title.trim();
        if (typeof c.downloadName === 'string' && c.downloadName.trim()) return c.downloadName.trim();
        return '';
    }

    /** The widget's Name, or `fallback` (else its schema label) when none is set. */
    function name(fallback) {
        return customName() || (fallback != null ? String(fallback) : ((schema && schema.label) || ''));
    }

    /**
     * A safe download file name: the Name if set, else `fallback`, plus `ext`.
     * Only `ext` itself is stripped from a typed name, so "Lecture 3.2" keeps
     * its ".2" and "Notes.pdf" doesn't become "Notes.pdf.pdf".
     */
    function fileName(fallback, ext) {
        ext = ext ? '.' + String(ext).replace(/^\./, '') : '';
        var n = (customName() || String(fallback || 'download'))
            .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim();
        if (ext && n.toLowerCase().slice(-ext.length) === ext.toLowerCase()) n = n.slice(0, -ext.length).trim();
        return (n || 'download') + ext;
    }

    function barTitle() {
        // A presenter-set title wins over the widget's generic name.
        return name();
    }

    function makeBtn(opts) {
        var b = el('button', 'bw-btn' + (opts.variant ? ' bw-btn--' + opts.variant : ''));
        b.type = 'button';
        if (opts.title) b.title = opts.title;
        if (opts.icon) b.innerHTML = opts.icon;
        if (opts.label) {
            var span = el('span');
            span.textContent = opts.label;
            b.appendChild(span);
        }
        if (opts.onClick) b.addEventListener('click', opts.onClick);
        return b;
    }

    function setScale(next) {
        var v = SCALE_STEPS[Math.max(0, Math.min(SCALE_STEPS.length - 1, next))];
        cfg().scale = v;
        applyScale();
        // Persist through the same path the settings panel uses, so the size
        // chosen for the room is still there next time the deck is opened.
        post({ type: 'widget-settings', widgetId: cfg().id, patch: { scale: v }, remove: [] });
        syncScaleButtons();
    }

    var scaleDown = null, scaleUp = null;

    function syncScaleButtons() {
        if (!scaleDown || !scaleUp) return;
        var i = nearestStep(currentScale());
        scaleDown.disabled = i <= 0;
        scaleUp.disabled = i >= SCALE_STEPS.length - 1;
    }

    function nearestStep(v) {
        var best = 0, bestD = Infinity;
        for (var i = 0; i < SCALE_STEPS.length; i++) {
            var d = Math.abs(SCALE_STEPS[i] - v);
            if (d < bestD) { bestD = d; best = i; }
        }
        return best;
    }

    function doReset() {
        if (typeof resetHandler === 'function') {
            try { resetHandler(); return; }
            catch (e) { console.warn('[widget] reset handler failed', e); }
        }
        // No handler: reloading the srcdoc document puts the widget back exactly
        // as the slide first rendered it, which is what reset means anyway.
        try { location.reload(); } catch (e) {}
    }

    var RESET_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';

    function buildBar() {
        var bar = el('div', 'bw-topbar');
        bar.id = 'bw-topbar';
        // A bar wider than the widget scrolls sideways. A mouse wheel only
        // scrolls up and down, so turn that into sideways here.
        bar.addEventListener('wheel', function (e) {
            if (bar.scrollWidth <= bar.clientWidth + 1) return;
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
            bar.scrollLeft += e.deltaY;
            e.preventDefault();
        }, { passive: false });

        titleEl = el('div', 'bw-topbar-title');
        titleEl.textContent = barTitle();
        bar.appendChild(titleEl);

        actionsEl = el('div', 'bw-topbar-actions');
        actionsEl.id = 'bw-topbar-actions';
        bar.appendChild(actionsEl);

        // The audience view gets the widget's own controls but not the
        // presenter's furniture.
        if (cfg().role === 'viewer') return bar;

        var utils = el('div', 'bw-topbar-utils');

        if (!(schema && schema.fontSize === false)) {
            var group = el('div', 'bw-fontsize');
            scaleDown = makeBtn({
                variant: 'icon', title: 'Smaller text',
                onClick: function () { setScale(nearestStep(currentScale()) - 1); },
            });
            scaleDown.innerHTML = '<span class="bw-fontsize-a-sm">A</span>';
            scaleUp = makeBtn({
                variant: 'icon', title: 'Larger text',
                onClick: function () { setScale(nearestStep(currentScale()) + 1); },
            });
            scaleUp.innerHTML = '<span class="bw-fontsize-a-lg">A</span>';
            group.appendChild(scaleDown);
            group.appendChild(scaleUp);
            utils.appendChild(group);
            syncScaleButtons();
        }

        utils.appendChild(makeBtn({
            variant: 'icon', title: 'Reset widget', icon: RESET_ICON, onClick: doReset,
        }));

        // Edit sits last: the top-right corner of every widget.
        if (canEdit()) {
            editBtn = makeBtn({ onClick: onEditButton });
            editBtn.classList.add('bw-edit-btn');
            editBtn.setAttribute('data-bw-print-hide', '');
            utils.appendChild(editBtn);
            paintEditButtons();
        }

        bar.appendChild(utils);
        return bar;
    }

    function buildTopbar() {
        if (barEl || !document.body) return;
        if (!readSchema()) return;
        if (schema && schema.topbar === false) return;

        var body = document.body;

        // Take the widget's own body layout before changing it and hand it to
        // the wrapper: a widget that laid its children out with
        // `body { display: flex }` keeps that layout, one level down. Height and
        // overflow are deliberately not copied — the wrapper is a flex child and
        // sizes itself from whatever the bar leaves.
        var cs = window.getComputedStyle(body);
        var wrap = el('div', 'bw-topbar-body');
        wrap.id = 'bw-topbar-body';
        ['display', 'flexDirection', 'flexWrap', 'gap', 'alignItems', 'justifyContent',
         'gridTemplateColumns', 'gridTemplateRows', 'gridAutoRows', 'gridAutoColumns',
         'padding', 'background', 'color', 'textAlign'].forEach(function (prop) {
            try { wrap.style[prop] = cs[prop]; } catch (e) {}
        });

        while (body.firstChild) wrap.appendChild(body.firstChild);

        barEl = buildBar();
        body.appendChild(barEl);
        body.appendChild(wrap);
        body.classList.add('bw-has-topbar');

        // No bar to hold the pencil (an overlay, or an inset without the
        // utilities): a faint one in the corner, shown while the pointer is
        // over the widget (widget-base.css).
        if (canEdit()) {
            floatEdit = makeBtn({ variant: 'icon', title: 'Edit this widget', icon: PENCIL_ICON, onClick: onEditButton });
            floatEdit.classList.add('bw-edit-float');
            floatEdit.setAttribute('data-bw-print-hide', '');
            body.appendChild(floatEdit);
        }

        adoptOwnBar(wrap);
        wireTitleEditing();

        // A widget that appends to <body> after this ran would land beside the
        // wrapper instead of inside it, and show up under the content. Move late
        // arrivals in, so a widget written without knowing about the bar still
        // behaves.
        try {
            new MutationObserver(function (records) {
                for (var i = 0; i < records.length; i++) {
                    var added = records[i].addedNodes;
                    for (var j = 0; j < added.length; j++) {
                        var n = added[j];
                        if (n === barEl || n === wrap || n === floatEdit) continue;
                        // Never re-parent an iframe: moving one reloads it and
                        // throws away its document. html2canvas renders into a
                        // hidden iframe it appends to <body>; moving that emptied
                        // the clone mid-capture, and every computed style came
                        // back "" ("Error parsing CSS component value,
                        // unexpected EOF" on PDF export).
                        if (n.nodeName === 'IFRAME') continue;
                        if (n.parentNode === body) wrap.appendChild(n);
                    }
                }
            }).observe(body, { childList: true });
        } catch (e) {}
    }

    // A widget that already draws its own bar marks it with `data-bw-topbar`
    // (or uses .bw-toolbar) and that element is MOVED into the shared bar — the
    // element itself, not a copy of its contents, so every id, listener and
    // piece of widget logic pointing at it keeps working untouched.
    //
    // It is moved rather than emptied because a widget may fill its bar later,
    // from script (the browser widget's toolbar is empty markup that its own
    // code populates on load); emptying it would quietly delete controls that
    // had not been created yet.
    //
    // `display: contents` then drops its box so its children become items of
    // the shared bar's own flex row, picking up the same spacing as every other
    // widget's controls. Set inline because the widget styles it by id, which
    // would otherwise win.
    function adoptOwnBar(wrap) {
        var own = wrap.querySelector('[data-bw-topbar]') || wrap.querySelector('.bw-toolbar');
        if (!own || !actionsEl) return;

        // If the widget already writes a title, its element BECOMES the bar's
        // title — restyled in place and adopted as what setTitle() writes to —
        // and ours is dropped. Taking the element over rather than copying its
        // text and deleting it matters: a widget may keep writing to that node
        // (the notebook puts the open file's name there), and deleting it would
        // silently break those updates.
        var ownTitle = own.querySelector('.bw-toolbar-title, [data-bw-title], .toolbar-title, #toolbar-title');
        if (ownTitle) {
            ownTitle.classList.add('bw-topbar-title');
            if (customName()) ownTitle.textContent = customName();
            if (titleEl && titleEl.parentNode) titleEl.parentNode.removeChild(titleEl);
            titleEl = ownTitle;
        }

        own.classList.add('bw-adopted-bar');
        own.style.display = 'contents';
        // Keep the widget's name from running straight into its first control.
        var sep = document.createElement('div');
        sep.className = 'bw-sep';
        actionsEl.appendChild(sep);
        actionsEl.appendChild(own);
    }

    /* ─── display: full, overlay, inset ────────────────────────── */
    // A widget is shown one of two ways, and declares which it supports with
    // "modes" in its schema (first one is the default):
    //
    //   full     the slide's content: the whole slide, with the shared bar.
    //   overlay  a small tool laid over part of a slide (a timer in the
    //            corner, a calculator beside a worked example): no bar at
    //            all, just the widget's own simplified view (body.bw-overlay).
    //
    // "fullSlide": true is shorthand for ["full"]; no "modes" also means
    // ["full"]. Which one a placed widget uses is its config item's `display`.
    //
    // A full-only widget can still be placed on part of a slide (older decks
    // do this): that is an inset, not a window — it drops the title and the
    // shared utilities and keeps its own controls as a slim strip, or no bar
    // at all when it has none (body.bw-partial).

    function near(a, b) { return Math.abs((+a || 0) - b) < 0.005; }

    function boxIsFull() {
        var c = cfg();
        var w = c.width == null ? 1 : c.width, h = c.height == null ? 1 : c.height;
        return near(c.x, 0) && near(c.y, 0) && near(w, 1) && near(h, 1);
    }

    // Keep in step with widgetModes() / widgetDisplay() in editor/widget-schema.js.
    function declaredModes() {
        if (!readSchema() || !schema || schema.fullSlide === true) return ['full'];
        var m = Array.isArray(schema.modes)
            ? schema.modes.filter(function (x) { return x === 'full' || x === 'overlay'; })
            : [];
        return m.length ? m : ['full'];
    }

    function displayMode() {
        if (editing && editGrew) return 'full';   // grown to the slide while edited
        var m = declaredModes(), d = cfg().display;
        if (m.indexOf(d) >= 0) return d;
        if (m.length === 1) return m[0];
        // Saved before modes existed: a widget that could be an overlay and
        // was placed on part of the slide was being used as one.
        return boxIsFull() ? 'full' : 'overlay';
    }

    function isPartial() {
        if (!readSchema()) return false;
        if (schema && schema.fullSlide === true) return false;
        if (editing && editGrew) return false;
        return displayMode() === 'full' && !boxIsFull();
    }

    var CONTROL_SEL = 'button, input, select, textarea, a[href], [role="button"]';
    var controlsQueued = false;

    // Does the bar hold anything to operate? (A title or a status pill alone
    // isn't worth a bar in an inset.)
    function syncBarControls() {
        controlsQueued = false;
        if (!barEl || !actionsEl) return;
        var any = false, list = actionsEl.querySelectorAll(CONTROL_SEL);
        for (var i = 0; i < list.length && !any; i++) {
            var c = list[i];
            if (c.hidden) continue;
            try { if (window.getComputedStyle(c).display === 'none') continue; } catch (e) {}
            any = true;
        }
        barEl.classList.toggle('bw-topbar--no-controls', !any);
    }

    function queueBarControls() {
        if (controlsQueued) return;
        controlsQueued = true;
        (window.requestAnimationFrame || setTimeout)(syncBarControls);
    }

    var lastDisplay = null;
    function syncLayoutMode() {
        if (!document.body || !readSchema()) return;
        var d = displayMode();
        document.body.classList.toggle('bw-overlay', d === 'overlay');
        document.body.classList.toggle('bw-partial', isPartial());
        document.documentElement.setAttribute('data-bw-display', d);
        syncBarControls();
        // Most widgets restyle with CSS alone; one that has to re-measure or
        // re-render listens for this.
        // Also on the first sync: a widget may have drawn before the kit
        // could tell it how it's shown.
        if (d !== lastDisplay) {
            lastDisplay = d;
            try { window.dispatchEvent(new CustomEvent('bw-display', { detail: { display: d } })); } catch (e) {}
        }
    }

    var controlsWatched = false;
    function watchBarControls() {
        if (controlsWatched || !actionsEl) return;
        controlsWatched = true;
        try {
            new MutationObserver(queueBarControls).observe(actionsEl, {
                childList: true, subtree: true,
                attributes: true, attributeFilter: ['hidden', 'style', 'class'],
            });
        } catch (e) {}
    }

    // What a widget uses to put its own controls in the bar and say what
    // resetting it means.
    var topbarApi = {
        get el() { return barEl; },
        addButton: function (opts) {
            var b = makeBtn(opts || {});
            if (actionsEl) actionsEl.appendChild(b);
            return b;
        },
        addElement: function (node) {
            if (node && actionsEl) actionsEl.appendChild(node);
            return node;
        },
        addSeparator: function () {
            var sep = el('div', 'bw-sep');
            if (actionsEl) actionsEl.appendChild(sep);
            return sep;
        },
        setTitle: function (text) {
            if (titleEl) titleEl.textContent = text == null ? '' : String(text);
        },
        onReset: function (fn) { resetHandler = typeof fn === 'function' ? fn : null; },
    };

    /* ─── printing (notes PDF) ──────────────────────────────────── */
    // When the presenter downloads the notes version of a deck, each widget
    // is asked how it should look on paper. A widget opts in with
    //
    //   BeamerWidget.print.register(async ({ scale }) => ({
    //       image: await BeamerWidget.print.snapshot(),   // drawn in the widget's box
    //       pages: [ { title, blocks: [ … ] } ],           // optional, after the slide
    //   }));
    //
    // A widget that registers nothing is drawn as a labelled placeholder box.
    // The host asks a throwaway copy (role 'viewer', printMode true, sockets
    // stubbed), already set to the live widget's state — so a handler only
    // has to draw what's in front of it. Images may be data URLs or canvases.
    var _printHandler = null;
    // html2canvas-pro: a maintained html2canvas fork that understands modern
    // colour syntax (oklch, color(), color-mix) — the base stylesheet uses it,
    // and stock html2canvas 1.4 throws on the first such colour it meets.
    var H2C_SRC = '/static/vendor/html2canvas-pro.min.js';
    var _h2cReady = null;

    function loadHtml2Canvas() {
        if (window.html2canvas) return Promise.resolve(window.html2canvas);
        if (!_h2cReady) {
            _h2cReady = new Promise(function (ok, bad) {
                var s = document.createElement('script');
                s.src = H2C_SRC;
                s.onload = function () { window.html2canvas ? ok(window.html2canvas) : bad(new Error('html2canvas missing')); };
                s.onerror = function () { _h2cReady = null; bad(new Error('could not load html2canvas')); };
                document.head.appendChild(s);
            });
        }
        return _h2cReady;
    }

    function cssVar(name, fallback) {
        try {
            var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            return v || fallback;
        } catch (e) { return fallback; }
    }

    // Two frames: enough for a re-render triggered by the printing class (or
    // by the handler itself) to reach layout and paint before it's captured.
    function nextFrames() {
        return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
    }

    /**
     * Rasterise part of the widget to a PNG data URL. `target` defaults to the
     * widget's content (everything under the host's top bar). Elements that
     * match `opts.ignore`, the top bar itself, and anything marked
     * data-bw-print-hide are left out.
     */
    function snapshot(target, opts) {
        opts = opts || {};
        var el = typeof target === 'string' ? document.querySelector(target)
               : target || document.getElementById('bw-topbar-body') || document.body;
        if (!el) return Promise.reject(new Error('nothing to snapshot'));
        var scale = opts.scale || _printScale || 2;
        var ignoreSel = '.bw-topbar, [data-bw-print-hide]' + (opts.ignore ? ', ' + opts.ignore : '');
        return loadHtml2Canvas().then(function (h2c) {
            return h2c(el, {
                scale: scale,
                backgroundColor: opts.background || cssVar('--bg', '#ffffff'),
                logging: false,
                useCORS: true,
                ignoreElements: function (n) {
                    try { return n.matches && n.matches(ignoreSel); } catch (e) { return false; }
                },
            });
        }).then(function (canvas) { return canvas.toDataURL('image/png'); });
    }

    function toDataUrl(img) {
        if (!img) return null;
        if (typeof img === 'string') return img;
        if (img.toDataURL) return img.toDataURL('image/png');   // a canvas
        return null;
    }

    // Canvases inside page blocks are converted here, so a handler can hand
    // back whatever it drew without encoding it itself.
    function normalisePages(pages) {
        if (!Array.isArray(pages)) return [];
        return pages.map(function (p) {
            if (!p || typeof p !== 'object') return null;
            var blocks = Array.isArray(p.blocks) ? p.blocks.map(function (b) {
                if (!b || typeof b !== 'object') return null;
                if (b.type === 'image') {
                    var w = b.width, h = b.height;
                    if (b.src && b.src.width && !w) { w = b.src.width; h = b.src.height; }
                    var src = toDataUrl(b.src);
                    return src ? { type: 'image', src: src, width: w || null, height: h || null } : null;
                }
                return { type: b.type || 'text', text: String(b.text == null ? '' : b.text),
                         mono: !!b.mono, tone: b.tone || null };
            }).filter(Boolean) : [];
            return { title: p.title ? String(p.title) : '', blocks: blocks,
                     columnWidth: +p.columnWidth > 0 ? +p.columnWidth : null };
        }).filter(Boolean);
    }

    /* ─── magnifier ─────────────────────────────────────────────── */
    // The host's magnifying lens draws the slide from canvases, but it can't
    // read an iframe's pixels. While the lens is over a widget the host asks
    // for a picture of it every few hundred ms; this answers with one (the
    // whole widget, bar included, as seen) as an ImageBitmap.
    var _lensBusy = false;
    function handleLens(d, source) {
        if (_lensBusy || !document.body) return;
        _lensBusy = true;
        var scale = Math.max(1, Math.min(4, +d.scale || 2));
        loadHtml2Canvas().then(function (h2c) {
            return h2c(document.body, {
                scale: scale,
                backgroundColor: null,
                logging: false,
                useCORS: true,
                width: window.innerWidth,
                height: window.innerHeight,
            });
        }).then(function (canvas) {
            return (window.createImageBitmap ? createImageBitmap(canvas) : Promise.resolve(null))
                .then(function (bmp) {
                    var msg = { type: 'widget-lens-shot', requestId: d.requestId, bitmap: bmp };
                    try { (source || parent).postMessage(msg, '*', bmp ? [bmp] : []); } catch (e) {}
                });
        }).catch(function () { /* nothing to show — the lens keeps the slide */ })
          .then(function () { _lensBusy = false; });
    }

    var _printScale = 2;
    // A print copy is asked as soon as its iframe loads, but a widget whose
    // scripts come from a slow CDN may not have run yet: its handler isn't
    // registered, its stylesheet may still be loading, and a state posted to
    // it would arrive before anything is listening and be lost. So the request
    // carries the state, and nothing happens until the document is complete,
    // every stylesheet has applied and the fonts are in; only then is the
    // state handed over (as the widget-set-state message it already handles)
    // and the widget asked to draw.
    var READY_LIMIT_MS = 30000;
    function whenLoaded() {
        return new Promise(function (ok) {
            if (document.readyState === 'complete') return ok();
            window.addEventListener('load', function () { ok(); }, { once: true });
            setTimeout(ok, READY_LIMIT_MS);
        });
    }
    function whenStyled() {
        var links = [].slice.call(document.querySelectorAll('link[rel="stylesheet"]'));
        return Promise.all(links.map(function (l) {
            if (l.sheet) return null;
            return new Promise(function (ok) {
                l.addEventListener('load', ok, { once: true });
                l.addEventListener('error', ok, { once: true });
                setTimeout(ok, 10000);
            });
        }));
    }
    function whenFonts() {
        try { return document.fonts && document.fonts.ready ? document.fonts.ready : null; }
        catch (e) { return null; }
    }
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    var _printing = {};   // requestId → true: the host re-sends until it hears back
    function handlePrint(d) {
        var reply = function (msg) {
            msg.type = 'widget-print-result';
            msg.requestId = d.requestId;
            msg.widgetId = cfg().id;
            post(msg);
        };
        post({ type: 'widget-print-ack', requestId: d.requestId });
        if (_printing[d.requestId]) return;
        _printing[d.requestId] = true;
        _printScale = d.scale || 2;
        var root = document.documentElement;

        whenLoaded().then(whenStyled).then(whenFonts).then(function () {
            if (d.state !== undefined) {
                // To ourselves, so it reaches the widget's own listener like
                // any host message would.
                try { window.postMessage({ type: 'widget-set-state', state: d.state }, '*'); } catch (e) {}
            }
            // Let the state apply and any re-render it starts settle.
            return wait(350);
        }).then(nextFrames).then(function () {
            if (!_printHandler) { reply({ ok: false, reason: 'unsupported' }); return; }
            root.classList.add('bw-printing');
            return nextFrames().then(function () {
                return _printHandler({ scale: _printScale });
            }).then(function (res) {
                res = res || {};
                return Promise.resolve(res.image).then(function (image) {
                    reply({ ok: true, image: toDataUrl(image), pages: normalisePages(res.pages) });
                });
            });
        }).catch(function (err) {
            console.warn('[widget] print failed', err);
            reply({ ok: false, reason: (err && err.message) || 'print failed' });
        }).then(function () { root.classList.remove('bw-printing'); });
    }

    var printApi = {
        register: function (fn) { _printHandler = typeof fn === 'function' ? fn : null; },
        snapshot: snapshot,
        /** The vendored html2canvas, loaded on first use. */
        html2canvas: loadHtml2Canvas,
        /** True inside the copy the host makes for printing. */
        get active() { return !!(window.BEAMER_PRINT || cfg().printMode); },
    };

    /* ─── wiring ────────────────────────────────────────────────── */

    window.addEventListener('message', function (e) {
        if (selfDispatch) return;   // our own local re-broadcast of widget-config
        var d = e.data || {};
        if (d.type === 'widget-cleanup')        { exitEdit(); return; }
        if (d.type === 'widget-asset-saved')    { onAssetSaved(d); return; }
        if (d.type === 'widget-print')          { handlePrint(d); return; }
        if (d.type === 'widget-lens')           { handleLens(d, e.source); return; }
        if (d.type === 'widget-flush-files') {
            if (_flushHandler) { try { _flushHandler(); } catch (err) { console.warn('[widget] flush failed', err); } }
            return;
        }
        if (d.type === 'widget-config' && d.config) {
            // A live settings change carries the config item, not what the
            // renderer adds at build time — keep the pre-loaded notebook.
            var prevNb = cfg().notebookContent;
            window.WIDGET_CONFIG = d.config;
            if (d.live && prevNb !== undefined && d.config.notebookContent === undefined) {
                window.WIDGET_CONFIG.notebookContent = prevNb;
            }
            applyScale();
            syncScaleButtons();
            syncTitle();
            if (editing && !canEdit()) exitEdit();
            syncLayoutMode();
            return;
        }
        // The host moved or resized the widget's box (edited in the editor
        // while the iframe stayed alive).
        if (d.type === 'widget-layout') {
            var c = cfg();
            ['x', 'y', 'width', 'height'].forEach(function (k) {
                if (typeof d[k] === 'number') c[k] = d[k];
            });
            if (typeof d.display === 'string') c.display = d.display;
            else if ('display' in d) delete c.display;
            syncLayoutMode();
        }
    });

    // Public API for the widget itself. Everything a widget needs from the
    // host goes through here rather than hand-rolled postMessage.
    window.BeamerWidget = {
        config:        cfg,
        serverOrigin:  serverOrigin,
        serverUrl:     serverUrl,
        saveFile:      saveFile,
        onFlushFiles:  onFlushFiles,
        // Editing on the widget itself — see "edit mode" above.
        edit:          editApi,
        topbar:        topbarApi,
        name:          function (fallback) { readSchema(); return name(fallback); },
        fileName:      function (fallback, ext) { readSchema(); return fileName(fallback, ext); },
        print:         printApi,
        // 'full' or 'overlay' — how this widget is being shown. Listen for
        // the window's 'bw-display' event to hear about a change.
        display:       function () { readSchema(); return displayMode(); },
    };

    // A widget's page never scrolls as a page, and its clipped boxes never
    // scroll to follow focus: focusing a field (the browser bringing it into
    // view) would otherwise shift the whole widget, or one pane of it, so it
    // no longer lines up with its slide. Boxes a widget scrolls on purpose
    // (overflow: auto, or a hidden one it syncs itself) are left alone.
    document.addEventListener('scroll', function (e) {
        var root = document.scrollingElement || document.documentElement;
        var t = (e.target === document || e.target === document.body) ? root : e.target;
        if (!t || !t.nodeType || t.nodeType !== 1) return;
        if (t === root || t === document.body) {
            if (root.scrollLeft || root.scrollTop) { root.scrollLeft = 0; root.scrollTop = 0; }
            if (document.body && (document.body.scrollLeft || document.body.scrollTop)) {
                document.body.scrollLeft = 0; document.body.scrollTop = 0;
            }
            return;
        }
        var a = document.activeElement;
        if (!a || a === t || !t.contains(a)) return;
        var cs = getComputedStyle(t);
        if (t.scrollLeft && /hidden|clip/.test(cs.overflowX)) t.scrollLeft = 0;
        if (t.scrollTop && /hidden|clip/.test(cs.overflowY)) t.scrollTop = 0;
    }, true);

    function init() {
        applyScale(); buildTopbar(); syncScaleButtons();
        watchBarControls(); syncLayoutMode();
    }

    init();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    }
})();
