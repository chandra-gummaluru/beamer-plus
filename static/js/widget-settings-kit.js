// Beamer+ widget settings kit — runs INSIDE each widget iframe.
//
// A widget's declared fields are edited in the editor's properties panel, which
// reads the same schema block from the parent side (see editor/widget-schema.js).
// What this kit provides to a widget is the rest of the host contract: the
// server origin, presentation scale, saving files into the deck, and an
// optional in-widget panel a widget can open for itself via
// BeamerWidget.openSettings().
//
// This file is injected into every widget iframe (see iframe-widget-renderer.js),
// right after window.WIDGET_CONFIG. It reads the widget's OWN schema block —
//
//   <script id="widget-schema" type="application/json">
//   { "label": "...", "fields": [ { "key": ..., "label": ..., "type": ... } ] }
//   </script>
//
// — renders a settings panel from it, and posts changes back to the parent,
// which merges them into the widget's config item so they survive a save.
//
// A widget that wants a bespoke settings UI declares "customSettings": true in
// its schema and handles the `widget-open-settings` message itself; the kit
// then stays out of the way entirely.
(function () {
    'use strict';
    if (window.__beamerWidgetSettings) return;
    window.__beamerWidgetSettings = true;

    // Keys the layout system owns — a widget never edits these about itself.
    // The parent enforces the same list; this copy just keeps them out of the UI.
    var RESERVED = [
        'id', 'type', 'x', 'y', 'width', 'height', 'zIndex',
        'builtin', 'src', 'interactive',
        'notebookContent', 'role', 'socketUrl',
        'sessionId', 'serverUrl', 'publicBaseUrl',
    ];

    /* ─── schema ────────────────────────────────────────────────── */

    // This script is injected at the TOP of <head> — before the widget's own
    // <script id="widget-schema"> has been parsed — so the schema cannot be
    // read at load time. It is read on first use instead, and the parent isn't
    // told whether we have settings until there is a document to read it from.
    var schema = null, fields = [], customSettings = false, hasSettings = false;
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
        fields = (schema && Array.isArray(schema.fields))
            ? schema.fields.filter(function (f) { return f && f.key && RESERVED.indexOf(f.key) === -1; })
            : [];
        customSettings = !!(schema && schema.customSettings);
        hasSettings = !customSettings && fields.length > 0;
        return true;
    }

    function cfg() { return window.WIDGET_CONFIG || (window.WIDGET_CONFIG = {}); }

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
    // A widget that declares a `scale` field gets the room-size control for
    // free: whatever the presenter picks is applied to --u, which the shared
    // base stylesheet uses to size everything the audience has to read.
    // Chrome stays fixed, so the furniture doesn't inflate with the content.

    function applyScale() {
        if (!readSchema()) return;
        var f = null;
        for (var i = 0; i < fields.length; i++) if (fields[i].key === 'scale') { f = fields[i]; break; }
        if (!f) return;
        var raw = cfg().scale !== undefined ? cfg().scale : f.default;
        var v = parseFloat(raw);
        if (!isNaN(v) && v > 0) document.documentElement.style.setProperty('--u', String(v));
    }
    function post(msg) { try { parent.postMessage(msg, '*'); } catch (e) {} }
    function announce() {
        if (!readSchema()) return;   // asked again on DOMContentLoaded
        post({ type: 'widget-has-settings', widgetId: cfg().id, has: hasSettings });
    }

    /* ─── styles ────────────────────────────────────────────────── */
    // Uses the design tokens Beamer+ injects ahead of this script, so the
    // panel matches the rest of the app in both light and dark.

    function injectStyles() {
        if (document.getElementById('bws-style')) return;
        var st = document.createElement('style');
        st.id = 'bws-style';
        st.textContent = [
            '.bws-root{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;',
            'background:var(--bg,#fff);color:var(--text,#1a1a18);font-family:var(--font-ui,system-ui,sans-serif);',
            'opacity:0;transition:opacity .12s ease}',
            '.bws-root.is-open{opacity:1}',
            '.bws-head{display:flex;align-items:center;justify-content:space-between;gap:8px;',
            'padding:12px 14px;border-bottom:1px solid var(--border,#e9e9e6);flex:0 0 auto}',
            '.bws-title{font-size:15px;font-weight:600;letter-spacing:-0.01em}',
            '.bws-x{border:none;background:none;cursor:pointer;color:var(--text-2,#6b6b65);',
            'font-size:18px;line-height:1;padding:4px 8px;border-radius:var(--radius,6px)}',
            '.bws-x:hover{background:var(--accent-bg,#f0f0ee);color:var(--text,#1a1a18)}',
            '.bws-body{flex:1 1 auto;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:14px}',
            '.bws-row{display:flex;flex-direction:column;gap:5px}',
            '.bws-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;',
            'color:var(--text-2,#6b6b65);display:flex;align-items:center;gap:6px}',
            '.bws-note{font-weight:400;text-transform:none;letter-spacing:0;font-size:10px;color:var(--text-3,#aeaea5)}',
            '.bws-input,.bws-select,.bws-area{width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;',
            'font-family:inherit;color:var(--text,#1a1a18);background:var(--bg-subtle,#f9f9f8);',
            'border:1px solid var(--border-med,#d4d4cf);border-radius:var(--radius,6px)}',
            '.bws-area{font-family:var(--font-mono,ui-monospace,monospace);resize:vertical;line-height:1.45}',
            '.bws-input:focus,.bws-select:focus,.bws-area:focus{outline:none;border-color:var(--accent,#52524e)}',
            '.bws-check{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}',
            '.bws-check input{width:15px;height:15px;accent-color:var(--accent,#52524e);cursor:pointer}',
            '.bws-file{display:flex;gap:6px;align-items:center}',
            '.bws-file .bws-input{flex:1 1 auto;min-width:0}',
            '.bws-btn{flex:0 0 auto;padding:6px 11px;font-size:12px;font-family:inherit;cursor:pointer;',
            'color:var(--text,#1a1a18);background:var(--bg-subtle,#f9f9f8);',
            'border:1px solid var(--border-med,#d4d4cf);border-radius:var(--radius,6px)}',
            '.bws-btn:hover{background:var(--accent-bg,#f0f0ee)}',
            '.bws-btn[disabled]{opacity:.55;cursor:default}',
            '.bws-empty{font-size:13px;color:var(--text-2,#6b6b65);line-height:1.5}',
        ].join('');
        document.head.appendChild(st);
    }

    /* ─── field rows ────────────────────────────────────────────── */

    function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

    // The value a control should show: what the presenter set, else the
    // schema's declared default.
    function effective(field) {
        var v = cfg()[field.key];
        return v !== undefined ? v : field.default;
    }

    function labelFor(field) {
        var lab = el('div', 'bws-label');
        lab.textContent = field.label || field.key;
        if (field.note) {
            var note = el('span', 'bws-note');
            note.textContent = field.note;
            lab.appendChild(note);
        }
        return lab;
    }

    // Each row returns { key, node, read() } — read() reports either a value to
    // write or that the key should be dropped, matching how the editor panel
    // used to treat a cleared field.
    function buildRow(field, onChange) {
        var eff = effective(field);
        var row = el('div', 'bws-row');
        var input;

        if (field.type === 'checkbox') {
            var lab = el('label', 'bws-check');
            input = el('input');
            input.type = 'checkbox';
            input.checked = eff === true;
            lab.appendChild(input);
            var span = el('span');
            span.textContent = field.label || field.key;
            lab.appendChild(span);
            row.appendChild(lab);

        } else if (field.type === 'select') {
            row.appendChild(labelFor(field));
            input = el('select', 'bws-select');
            // Options may be declared as { v, l } pairs or as plain strings.
            // Compare as strings: a deck may have stored 1.4 where the schema
            // declares "1.4", and a strict compare would lose the selection.
            (field.options || []).forEach(function (o) {
                var isObj = o && typeof o === 'object';
                var v = isObj ? o.v : o;
                var l = isObj ? (o.l !== undefined ? o.l : o.v) : o;
                var opt = el('option');
                opt.value = v;
                opt.textContent = l;
                if (String(eff) === String(v)) opt.selected = true;
                input.appendChild(opt);
            });
            row.appendChild(input);

        } else if (field.type === 'ai-model') {
            row.appendChild(labelFor(field));
            input = el('select', 'bws-select');
            var loading = el('option');
            loading.value = eff == null ? '' : String(eff);
            loading.textContent = eff ? String(eff) : '— loading… —';
            input.appendChild(loading);
            loadModels(input, eff);
            row.appendChild(input);

        } else if (field.type === 'textarea' || field.type === 'textarea-lines') {
            row.appendChild(labelFor(field));
            input = el('textarea', 'bws-area');
            input.rows = field.rows || (field.type === 'textarea-lines' ? 4 : 3);
            input.spellcheck = false;
            if (field.placeholder) input.placeholder = field.placeholder;
            input.value = Array.isArray(eff) ? eff.join('\n') : (eff == null ? '' : String(eff));
            row.appendChild(input);

        } else if (field.type === 'file') {
            row.appendChild(labelFor(field));
            var fileRow = el('div', 'bws-file');
            input = el('input', 'bws-input');
            input.type = 'text';
            input.readOnly = true;
            input.placeholder = 'No file selected';
            input.value = eff == null ? '' : String(eff);
            input.title = input.value;
            var btn = el('button', 'bws-btn');
            btn.type = 'button';
            btn.textContent = 'Upload';
            btn.addEventListener('click', function () { pickAsset(field, input, btn, onChange); });
            fileRow.appendChild(input);
            fileRow.appendChild(btn);
            row.appendChild(fileRow);

        } else {
            row.appendChild(labelFor(field));
            input = el('input', 'bws-input');
            input.type = field.type === 'password' ? 'password'
                       : (field.type === 'number' || field.type === 'number-nullable') ? 'number'
                       : 'text';
            if (field.min !== undefined)  input.min  = field.min;
            if (field.max !== undefined)  input.max  = field.max;
            if (field.step !== undefined) input.step = field.step;
            if (field.placeholder) input.placeholder = field.placeholder;
            input.value = eff == null ? '' : String(eff);
            row.appendChild(input);
        }

        input.addEventListener('input',  onChange);
        input.addEventListener('change', onChange);

        return {
            key: field.key,
            node: row,
            read: function () {
                if (field.type === 'checkbox') return { value: input.checked };
                if (field.type === 'number' || field.type === 'number-nullable') {
                    var raw = input.value.trim();
                    if (raw === '') return { remove: true };
                    var n = parseFloat(raw);
                    return isNaN(n) ? { remove: true } : { value: n };
                }
                if (field.type === 'textarea-lines') {
                    var lines = input.value.split('\n').map(function (s) { return s.trim(); })
                                     .filter(function (s) { return !!s; });
                    return lines.length ? { value: lines } : { remove: true };
                }
                return input.value === '' ? { remove: true } : { value: input.value };
            },
        };
    }

    /* ─── ai-model options ──────────────────────────────────────── */

    function loadModels(select, current) {
        var base = cfg().serverUrl;
        if (!base) return;
        fetch(base.replace(/\/+$/, '') + '/api/models')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var models = (data && data.models) || [];
                select.textContent = '';
                var none = el('option');
                none.value = '';
                none.textContent = '— no model —';
                select.appendChild(none);
                models.forEach(function (m) {
                    var opt = el('option');
                    opt.value = m;
                    opt.textContent = m;
                    if (current === m) opt.selected = true;
                    select.appendChild(opt);
                });
            })
            .catch(function () {
                var first = select.firstChild;
                if (first && first.textContent === '— loading… —') first.textContent = '— unavailable —';
            });
    }

    /* ─── file fields ───────────────────────────────────────────── */
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

    function pickAsset(field, input, btn, onChange) {
        var picker = el('input');
        picker.type = 'file';
        if (field.accept) picker.accept = field.accept;
        picker.addEventListener('change', function () {
            var file = picker.files && picker.files[0];
            if (!file) return;
            btn.disabled = true;
            btn.textContent = 'Uploading…';
            file.arrayBuffer().then(function (buffer) {
                return saveFile({ key: field.key, name: file.name, folder: field.folder || 'files', buffer: buffer });
            }).then(function (path) {
                btn.disabled = false;
                btn.textContent = 'Upload';
                input.value = path;
                input.title = path;
                onChange();
            }).catch(function () {
                btn.disabled = false;
                btn.textContent = 'Upload';
            });
        });
        picker.click();
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

    /* ─── panel ─────────────────────────────────────────────────── */

    var root = null, rows = [], isOpen = false, commitTimer = null, selfDispatch = false;

    function commit() {
        var patch = {}, remove = [];
        rows.forEach(function (r) {
            var res = r.read();
            if (res.remove) remove.push(r.key);
            else patch[r.key] = res.value;
        });
        post({ type: 'widget-settings', widgetId: cfg().id, patch: patch, remove: remove });

        // Apply to our own config too, so a widget that re-reads on
        // `widget-config` updates while the panel is still open rather than
        // waiting for the next load.
        var c = cfg();
        remove.forEach(function (k) { delete c[k]; });
        Object.keys(patch).forEach(function (k) { c[k] = patch[k]; });
        applyScale();
        selfDispatch = true;
        try { window.dispatchEvent(new MessageEvent('message', { data: { type: 'widget-config', config: c } })); }
        catch (e) {}
        selfDispatch = false;
    }

    function scheduleCommit() {
        if (commitTimer) clearTimeout(commitTimer);
        commitTimer = setTimeout(function () { commitTimer = null; commit(); }, 150);
    }

    function onKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        closePanel();
    }

    function build() {
        injectStyles();
        rows = [];
        root = el('div', 'bws-root');

        var head  = el('div', 'bws-head');
        var title = el('span', 'bws-title');
        title.textContent = ((schema && schema.label) || 'Widget') + ' settings';
        var x = el('button', 'bws-x');
        x.type = 'button';
        x.title = 'Close settings';
        x.textContent = '×';
        x.addEventListener('click', function () { closePanel(); });
        head.appendChild(title);
        head.appendChild(x);

        var body = el('div', 'bws-body');
        if (!fields.length) {
            var empty = el('div', 'bws-empty');
            empty.textContent = 'This widget has no settings.';
            body.appendChild(empty);
        } else {
            fields.forEach(function (f) {
                var row = buildRow(f, scheduleCommit);
                rows.push(row);
                body.appendChild(row.node);
            });
        }

        root.appendChild(head);
        root.appendChild(body);
    }

    function openPanel() {
        if (isOpen) return;
        isOpen = true;
        // Grow to the full slide first — most widgets are far too small to
        // hold a settings form at their placed size.
        post({ type: 'widget-expand', widgetId: cfg().id });
        build();
        document.body.appendChild(root);
        requestAnimationFrame(function () { if (root) root.classList.add('is-open'); });
        document.addEventListener('keydown', onKey, true);
    }

    // silent: the parent already knows (it asked us to close), so don't tell it again.
    function closePanel(silent) {
        if (!isOpen) return;
        isOpen = false;
        document.removeEventListener('keydown', onKey, true);
        if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; commit(); }
        if (root && root.parentNode) root.parentNode.removeChild(root);
        root = null;
        rows = [];
        post({ type: 'widget-collapse', widgetId: cfg().id });
        if (!silent) post({ type: 'widget-settings-close', widgetId: cfg().id });
    }

    /* ─── wiring ────────────────────────────────────────────────── */

    window.addEventListener('message', function (e) {
        if (selfDispatch) return;   // our own local re-broadcast of widget-config
        var d = e.data || {};
        if (d.type === 'widget-open-settings')  { readSchema(); if (hasSettings) openPanel(); return; }
        if (d.type === 'widget-close-settings') { closePanel(true); return; }
        if (d.type === 'widget-asset-saved')    { onAssetSaved(d); return; }
        if (d.type === 'widget-flush-files') {
            if (_flushHandler) { try { _flushHandler(); } catch (err) { console.warn('[widget] flush failed', err); } }
            return;
        }
        if (d.type === 'widget-config' && d.config) {
            window.WIDGET_CONFIG = d.config;
            applyScale();
            announce();  // the id may only have arrived with this message
        }
    });

    // Public API for the widget itself. Everything a widget needs from the
    // host goes through here rather than hand-rolled postMessage.
    window.BeamerWidget = {
        config:        cfg,
        serverOrigin:  serverOrigin,
        saveFile:      saveFile,
        onFlushFiles:  onFlushFiles,
        openSettings:  function () { readSchema(); if (hasSettings) openPanel(); },
        closeSettings: function () { closePanel(); },
        hasSettings:   function () { readSchema(); return hasSettings; },
    };

    function init() { applyScale(); announce(); }

    init();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    }
})();
