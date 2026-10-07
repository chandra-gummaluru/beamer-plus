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
        'id', 'type', 'x', 'y', 'width', 'height', 'zIndex', 'step', 'display',
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
        // Every widget with a schema gets a Name (see name() below). Keep in
        // step with nameField() in editor/widget-schema.js.
        if (schema && !fields.some(function (f) { return f.key === 'title'; })) {
            fields.unshift({ key: 'title', label: 'Name', type: 'text',
                             placeholder: schema.label || 'Title and download file name' });
        }
        // …and a Text size, the stepper's default, offering its steps. Keep in
        // step with textSizeField() in editor/widget-schema.js.
        if (schema && schema.fontSize !== false) {
            var own = -1;
            for (var k = 0; k < fields.length; k++) if (fields[k].key === 'scale') { own = k; break; }
            var def = own >= 0 && fields[own].default != null ? String(fields[own].default) : '1.4';
            if (own >= 0) fields.splice(own, 1);
            var at = 0;
            for (var t = 0; t < fields.length; t++) if (fields[t].key === 'title') { at = t + 1; break; }
            fields.splice(at, 0, { key: 'scale', label: 'Text size', type: 'select', default: def,
                options: ['1', '1.2', '1.4', '1.7', '2', '2.4'].map(function (v) {
                    return { v: v, l: Math.round(parseFloat(v) * 100) + '%' };
                }) });
        }
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

    function fieldByKey(key) {
        if (!readSchema()) return null;
        for (var i = 0; i < fields.length; i++) if (fields[i].key === key) return fields[i];
        return null;
    }

    // The presentation scale in force: what the presenter set, else the scale
    // field's default if the widget declares one, else the base stylesheet's.
    // Every widget has a scale now — the top bar's stepper is the control — so
    // this no longer requires a declared field.
    function currentScale() {
        if (!readSchema()) return 1.4;
        var f = fieldByKey('scale');
        var raw = cfg().scale !== undefined ? cfg().scale : (f ? f.default : undefined);
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
            '.bws-input,.bws-select,.bws-area{width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;',
            'font-family:inherit;color:var(--text,#1a1a18);background:var(--bg-subtle,#f9f9f8);',
            'border:1px solid var(--border-med,#d4d4cf);border-radius:var(--radius,6px)}',
            '.bws-area{font-family:var(--font-mono,ui-monospace,monospace);resize:vertical;line-height:1.45}',
            '.bws-input:focus,.bws-select:focus,.bws-area:focus{outline:none;border-color:var(--accent,#52524e)}',
            // On/off: a row shaped like the inputs, label left, switch right.
            '.bws-check{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;',
            'cursor:pointer;padding:5px 6px 5px 8px;background:var(--bg-subtle,#f9f9f8);',
            'border:1px solid var(--border-med,#d4d4cf);border-radius:var(--radius,6px)}',
            '.bws-switch{appearance:none;-webkit-appearance:none;flex:0 0 auto;position:relative;width:34px;',
            'height:20px;margin:0;border-radius:999px;background:var(--border-med,#d4d4cf);cursor:pointer;',
            'transition:background .12s}',
            '.bws-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;',
            'border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .12s}',
            '.bws-switch:checked{background:var(--text,#1a1a18)}',
            '.bws-switch:checked::after{transform:translateX(14px)}',
            '.bws-file{display:flex;gap:6px;align-items:center}',
            '.bws-file .bws-input{flex:1 1 auto;min-width:0}',
            '.bws-btn{flex:0 0 auto;padding:6px 11px;font-size:12px;font-family:inherit;cursor:pointer;',
            'color:var(--text,#1a1a18);background:var(--bg-subtle,#f9f9f8);',
            'border:1px solid var(--border-med,#d4d4cf);border-radius:var(--radius,6px)}',
            '.bws-btn:hover{background:var(--accent-bg,#f0f0ee)}',
            '.bws-btn[disabled]{opacity:.55;cursor:default}',
            '.bws-empty{font-size:13px;color:var(--text-2,#6b6b65);line-height:1.5}',
            '.bws-dur{display:flex;gap:8px}',
            '.bws-dur-part{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:6px}',
            '.bws-dur-part .bws-input{flex:1 1 auto;min-width:0}',
            '.bws-dur-unit{flex:0 0 auto;font-size:12px;color:var(--text-3,#9a9a94)}',
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

    // Label only — see the matching note in editor/properties.js.
    function labelFor(field) {
        var lab = el('div', 'bws-label');
        lab.textContent = field.label || field.key;
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
            var span = el('span');
            span.textContent = field.label || field.key;
            input = el('input', 'bws-switch');
            input.type = 'checkbox';
            input.setAttribute('role', 'switch');
            input.checked = eff === true;
            lab.appendChild(span);
            lab.appendChild(input);
            row.appendChild(lab);

        } else if (field.type === 'select') {
            row.appendChild(labelFor(field));
            input = el('select', 'bws-select');
            var matched = false;
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
                if (String(eff) === String(v)) { opt.selected = true; matched = true; }
                input.appendChild(opt);
            });
            // A saved value no option matches (an older deck's 1.8 where the
            // sizes now step 1.7, 2): show the nearest, not the first.
            if (!matched && !isNaN(parseFloat(eff))) {
                var best = -1, bestD = Infinity;
                for (var oi = 0; oi < input.options.length; oi++) {
                    var dd = Math.abs(parseFloat(input.options[oi].value) - parseFloat(eff));
                    if (dd < bestD) { bestD = dd; best = oi; }
                }
                if (best >= 0) input.selectedIndex = best;
            }
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

        } else if (field.type === 'duration') {
            // Stored as whole seconds, typed as minutes and seconds. Keep in
            // step with the editor's copy in editor/widget-fields.js.
            row.appendChild(labelFor(field));
            var dur = el('div', 'bws-dur');
            var part = function (unit) {
                var pl = el('label', 'bws-dur-part');
                var pi = el('input', 'bws-input');
                pi.type = 'number'; pi.min = '0'; pi.step = '1'; pi.inputMode = 'numeric';
                pi.setAttribute('aria-label', (field.label || field.key) + ' — ' + (unit === 'min' ? 'minutes' : 'seconds'));
                var pu = el('span', 'bws-dur-unit');
                pu.textContent = unit;
                pl.appendChild(pi); pl.appendChild(pu);
                dur.appendChild(pl);
                return pi;
            };
            var dMin = part('min'), dSec = part('sec');
            var showDur = function (t) {
                t = Math.max(0, Math.round(Number(t)));
                dMin.value = String(Math.floor(t / 60));
                dSec.value = String(t % 60);
            };
            if (eff != null && eff !== '' && isFinite(Number(eff))) showDur(eff);
            else if (field.default != null && isFinite(Number(field.default))) {
                var dt = Math.round(Number(field.default));
                dMin.placeholder = String(Math.floor(dt / 60));
                dSec.placeholder = String(dt % 60);
            }
            dur.addEventListener('change', function () {
                var t = durationTotal(dMin, dSec);
                if (t != null) showDur(t);
            });
            row.appendChild(dur);
            input = { mins: dMin, secs: dSec,
                      addEventListener: function (ev, fn) {
                          dMin.addEventListener(ev, fn); dSec.addEventListener(ev, fn);
                      } };

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
                if (field.type === 'duration') {
                    var total = durationTotal(input.mins, input.secs);
                    if (total == null) return { remove: true };
                    var lo = field.min !== undefined ? Number(field.min) : 1;
                    return { value: Math.max(lo, total) };
                }
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

    // Minutes + seconds boxes → whole seconds, or null when both are empty.
    function durationTotal(mins, secs) {
        var m = mins.value.trim(), sv = secs.value.trim();
        if (m === '' && sv === '') return null;
        var t = (parseFloat(m) || 0) * 60 + (parseFloat(sv) || 0);
        return Math.max(0, Math.round(t));
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

    // `showIf: { otherKey: value | [values] }` on a field hides it unless
    // another field currently holds one of those values. Mirrors the editor's
    // properties panel so both surfaces show the same form.
    function syncVisibility() {
        var values = {};
        rows.forEach(function (r) {
            var res = r.read();
            values[r.key] = res.remove ? (r.field ? r.field['default'] : undefined) : res.value;
        });
        rows.forEach(function (r) {
            var cond = r.field && r.field.showIf, show = true;
            if (cond && typeof cond === 'object') {
                show = Object.keys(cond).every(function (k) {
                    var want = Array.isArray(cond[k]) ? cond[k] : [cond[k]];
                    return want.some(function (w) { return String(w) === String(values[k]); });
                });
            }
            r.node.style.display = show ? '' : 'none';
        });
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
            var onFieldChange = function () { syncVisibility(); scheduleCommit(); };
            fields.forEach(function (f) {
                var row = buildRow(f, onFieldChange);
                row.field = f;
                rows.push(row);
                body.appendChild(row.node);
            });
            syncVisibility();
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

        adoptOwnBar(wrap);

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
                        if (n === barEl || n === wrap) continue;
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
        var ignoreSel = '.bw-topbar, [data-bw-print-hide], .bws-root' + (opts.ignore ? ', ' + opts.ignore : '');
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
                ignoreElements: function (n) {
                    try { return n.matches && n.matches('.bws-root'); } catch (e) { return false; }
                },
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
        if (d.type === 'widget-open-settings')  { readSchema(); if (hasSettings) openPanel(); return; }
        if (d.type === 'widget-close-settings') { closePanel(true); return; }
        if (d.type === 'widget-asset-saved')    { onAssetSaved(d); return; }
        if (d.type === 'widget-print')          { handlePrint(d); return; }
        if (d.type === 'widget-lens')           { handleLens(d, e.source); return; }
        if (d.type === 'widget-flush-files') {
            if (_flushHandler) { try { _flushHandler(); } catch (err) { console.warn('[widget] flush failed', err); } }
            return;
        }
        if (d.type === 'widget-config' && d.config) {
            window.WIDGET_CONFIG = d.config;
            applyScale();
            syncScaleButtons();
            if (titleEl) titleEl.textContent = barTitle();
            syncLayoutMode();
            announce();  // the id may only have arrived with this message
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
        openSettings:  function () { readSchema(); if (hasSettings) openPanel(); },
        closeSettings: function () { closePanel(); },
        hasSettings:   function () { readSchema(); return hasSettings; },
        topbar:        topbarApi,
        name:          function (fallback) { readSchema(); return name(fallback); },
        fileName:      function (fallback, ext) { readSchema(); return fileName(fallback, ext); },
        print:         printApi,
        // 'full' or 'overlay' — how this widget is being shown. Listen for
        // the window's 'bw-display' event to hear about a change.
        display:       function () { readSchema(); return displayMode(); },
    };

    function init() {
        applyScale(); announce(); buildTopbar(); syncScaleButtons();
        watchBarControls(); syncLayoutMode();
    }

    init();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    }
})();
