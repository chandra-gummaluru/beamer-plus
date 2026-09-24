// Widget settings form — the controls for a widget's own declared fields,
// built from its `widget-schema` block (see editor/widget-schema.js).
//
// One builder serves both places a widget is configured from: the narrow
// properties sidebar and the roomy settings dialog (widget-settings-modal.js).
// Both edit the same config item, so switching between them loses nothing.
//
// Beyond the basic field types, a schema can opt into richer editing with
// hints that the in-widget settings kit simply ignores — so the kit keeps
// working unchanged on the same schema:
//
//   section: "Answers"        Starts a group. Fields without one join the
//                             group above them. Groups whose fields are all
//                             hidden (showIf) hide too.
//   note: "Markdown · $…$"    A short aside shown next to the label.
//   mono: true                Monospace textarea, for code.
//   editor: "list"            On a textarea-lines field: one input per line,
//                             with add / remove, Enter for a new row, and
//                             multi-line paste split into rows.
//     correct: { key, base }  …plus a "correct answer" toggle on each row,
//                             written as a (base-indexed) position to `key`.
//                             That field is then edited here, not on its own.
//     itemPlaceholder: "…"    Placeholder for each row ("Option 1", …).
//   blanks: { pattern, insert }
//                             On a textarea: a template editor that
//                             highlights every match of `pattern`, counts
//                             them, and has a button that turns the
//                             selection into `insert`.
//
// Every control sits inside the form's root and reports changes as bubbling
// `input` events, so whoever hosts the form applies them with one listener.
import { ctx, WIDGET_RESERVED } from './context.js';
import { saveWidgetAsset } from './widget-settings.js';
import { sessionUrl } from '../app/session.js';

/**
 * @param {{label?:string, fields:object[]}} schema
 * @param {object} item            the widget's config item (read for initial values)
 * @param {'panel'|'modal'} variant
 * @returns {{ node: HTMLElement, apply(item): void, syncVisibility(): void, focusFirst(): void }}
 */
export function buildWidgetForm(schema, item, variant = 'panel') {
    const root = document.createElement('div');
    root.className = `wf wf--${variant}`;

    // Fields another control edits on their behalf (a list's correct answer).
    const claimed = new Set();
    for (const f of schema.fields) {
        if (isListField(f) && f.correct?.key) claimed.add(f.correct.key);
    }

    const rows = [];
    const groups = [];
    let group = null;
    for (const field of schema.fields) {
        if (claimed.has(field.key)) continue;
        if (!group || (field.section && field.section !== group.title)) {
            group = makeGroup(field.section || '', variant);
            groups.push(group);
            root.appendChild(group.node);
        }
        const row = buildFieldRow(field, item, variant);
        row.field = field;
        row.group = group;
        if (row.wide) group.node.classList.add('is-wide');
        rows.push(row);
        group.body.appendChild(row.node);
    }

    // The dialog has room for two columns: the groups holding long content
    // (a question, an answer list, a template) down the wide left column,
    // everything short (name, toggles, pickers) stacked on the right.
    if (variant === 'modal') {
        const main = document.createElement('div');
        main.className = 'wf-col wf-col--main';
        const side = document.createElement('div');
        side.className = 'wf-col wf-col--side';
        for (const g of groups) (g.node.classList.contains('is-wide') ? main : side).appendChild(g.node);
        if (main.children.length) root.appendChild(main);
        if (side.children.length) root.appendChild(side);
        root.classList.toggle('is-single', !main.children.length || !side.children.length);
    }

    function values() {
        const out = {};
        for (const r of rows) {
            const res = r.read();
            out[r.key] = res.remove ? r.field.default : res.value;
        }
        return out;
    }

    // A field may declare `showIf: { otherKey: value | [values] }` — it only
    // applies while another field holds one of those values (an answer list
    // means nothing to an open-ended poll). Hidden rather than removed, so its
    // value is kept and switching back restores what the presenter typed.
    function syncVisibility() {
        const vals = values();
        for (const r of rows) r.node.hidden = !fieldVisible(r.field, vals);
        for (const g of groups) {
            g.node.hidden = !rows.some(r => r.group === g && !r.node.hidden);
        }
        // Dialog columns: drop one that has nothing showing, and let the
        // other take the full width.
        const cols = Array.from(root.querySelectorAll(':scope > .wf-col'));
        if (cols.length) {
            for (const col of cols) col.hidden = !Array.from(col.children).some(c => !c.hidden);
            root.classList.toggle('is-single', cols.filter(c => !c.hidden).length < 2);
        }
    }

    // Write every field back onto the item. A cleared field is deleted rather
    // than stored empty, so the widget falls back to its own default exactly
    // as it would through its in-widget panel.
    function apply(target) {
        for (const r of rows) {
            if (WIDGET_RESERVED.has(r.key)) continue;   // a widget can't move itself
            const res = r.read();
            if (res.remove) delete target[r.key]; else target[r.key] = res.value;
            for (const [k, extra] of Object.entries(res.extra || {})) {
                if (WIDGET_RESERVED.has(k)) continue;
                if (extra.remove) delete target[k]; else target[k] = extra.value;
            }
        }
    }

    function focusFirst() {
        rows.find(r => !r.node.hidden)?.node.querySelector('input, textarea, select')?.focus();
    }

    syncVisibility();
    return { node: root, apply, syncVisibility, focusFirst };
}

/* ─── groups ─────────────────────────────────────────────────────────── */

function makeGroup(title, variant) {
    const node = document.createElement(variant === 'modal' ? 'section' : 'div');
    node.className = 'wf-group';
    if (title) {
        const h = document.createElement('div');
        h.className = 'wf-group-title';
        h.textContent = title;
        node.appendChild(h);
    }
    const body = document.createElement('div');
    body.className = 'wf-group-body';
    node.appendChild(body);
    return { title, node, body };
}

function fieldVisible(field, values) {
    const cond = field?.showIf;
    if (!cond || typeof cond !== 'object') return true;
    return Object.keys(cond).every(k => {
        const want = Array.isArray(cond[k]) ? cond[k] : [cond[k]];
        return want.some(w => String(w) === String(values[k]));
    });
}

/* ─── rows ───────────────────────────────────────────────────────────── */

// What a control should show: what the presenter set, else the schema's default.
function fieldValue(item, field) {
    const v = item[field.key];
    return v !== undefined ? v : field.default;
}

function fieldLabel(field) {
    const lab = document.createElement('div');
    lab.className = 'editor-prop-label';
    lab.textContent = field.label || field.key;
    if (field.note) {
        const note = document.createElement('span');
        note.className = 'editor-prop-label-note';
        note.textContent = field.note;
        lab.appendChild(note);
    }
    return lab;
}

const isListField     = (f) => f?.type === 'textarea-lines' && f.editor === 'list';
const isTemplateField = (f) => f?.type === 'textarea' && f.blanks && typeof f.blanks === 'object';

// One control per declared field. Mirrors the widget settings kit's field
// types and read() semantics — notably that clearing a field drops the key
// so the widget's own default applies again — so a widget behaves the same
// whichever surface configured it.
function buildFieldRow(field, item, variant) {
    if (isListField(field))     return buildListRow(field, item);
    if (isTemplateField(field)) return buildTemplateRow(field, item, variant);

    const eff = fieldValue(item, field);
    const row = document.createElement('div');
    row.className = 'editor-prop-row';
    let input, wide = false;

    if (field.type === 'checkbox') {
        const lab = document.createElement('label');
        lab.className = 'editor-prop-checkbox-row';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = eff === true;
        lab.appendChild(input);
        lab.appendChild(document.createTextNode(field.label || field.key));
        row.appendChild(lab);

    } else if (field.type === 'select') {
        row.appendChild(fieldLabel(field));
        input = document.createElement('select');
        input.className = 'editor-prop-select';
        for (const o of field.options || []) {
            const isObj = o && typeof o === 'object';
            const value = isObj ? o.v : o;
            const label = isObj ? (o.l !== undefined ? o.l : o.v) : o;
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            // Compared as strings: a deck may hold 1.4 where the schema
            // declares "1.4", and a strict compare would lose the selection.
            if (String(eff) === String(value)) opt.selected = true;
            input.appendChild(opt);
        }
        row.appendChild(input);

    } else if (field.type === 'ai-model') {
        row.appendChild(fieldLabel(field));
        input = document.createElement('select');
        input.className = 'editor-prop-select';
        fillModelOptions(input, eff);
        row.appendChild(input);

    } else if (field.type === 'textarea' || field.type === 'textarea-lines') {
        row.appendChild(fieldLabel(field));
        input = document.createElement('textarea');
        input.className = 'editor-prop-input editor-prop-area' + (field.mono ? ' wf-mono' : '');
        input.rows = field.rows || (field.type === 'textarea-lines' ? 4 : 3);
        input.spellcheck = false;
        if (field.placeholder) input.placeholder = field.placeholder;
        input.value = Array.isArray(eff) ? eff.join('\n') : (eff == null ? '' : String(eff));
        row.appendChild(input);
        autoGrow(input, variant);
        wide = true;

    } else if (field.type === 'file') {
        row.appendChild(fieldLabel(field));
        const fileRow = document.createElement('div');
        fileRow.className = 'editor-prop-file';
        input = document.createElement('input');
        input.className = 'editor-prop-input';
        input.type = 'text';
        input.readOnly = true;
        input.placeholder = 'No file selected';
        input.value = eff == null ? '' : String(eff);
        input.title = input.value;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn editor-prop-file-btn';
        btn.textContent = 'Upload';
        btn.addEventListener('click', () => pickWidgetAsset(field, item, input, btn));
        fileRow.appendChild(input);
        fileRow.appendChild(btn);
        row.appendChild(fileRow);

    } else {
        row.appendChild(fieldLabel(field));
        input = document.createElement('input');
        input.className = 'editor-prop-input';
        input.type = field.type === 'password' ? 'password'
                   : (field.type === 'number' || field.type === 'number-nullable') ? 'number'
                   : 'text';
        if (field.min  !== undefined) input.min  = field.min;
        if (field.max  !== undefined) input.max  = field.max;
        if (field.step !== undefined) input.step = field.step;
        if (field.placeholder) input.placeholder = field.placeholder;
        input.value = eff == null ? '' : String(eff);
        row.appendChild(input);
    }

    return {
        key: field.key,
        node: row,
        wide,
        read() {
            if (field.type === 'checkbox') return { value: input.checked };
            if (field.type === 'number' || field.type === 'number-nullable') {
                const raw = input.value.trim();
                if (raw === '') return { remove: true };
                const n = parseFloat(raw);
                return isNaN(n) ? { remove: true } : { value: n };
            }
            if (field.type === 'textarea-lines') {
                const lines = input.value.split('\n').map(s => s.trim()).filter(Boolean);
                return lines.length ? { value: lines } : { remove: true };
            }
            return input.value === '' ? { remove: true } : { value: input.value };
        },
    };
}

// Grow a textarea with its content (between its `rows` and a cap), so a long
// question never hides behind a scrollbar in a box three lines tall.
function autoGrow(ta, variant) {
    const cap = variant === 'modal' ? 0.6 * window.innerHeight : 320;
    const fit = () => {
        if (!ta.isConnected) return;
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(cap, ta.scrollHeight + 2)}px`;
    };
    ta.addEventListener('input', fit);
    // Not measurable until it's in the document and visible — a field hidden
    // by showIf has no width — so refit whenever the width changes (which is
    // also when the wrapping, and so the height it needs, changes).
    requestAnimationFrame(fit);
    let lastW = 0;
    new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width || 0;
        if (w && w !== lastW) { lastW = w; requestAnimationFrame(fit); }
    }).observe(ta);
    return fit;
}

/* ─── list editor ────────────────────────────────────────────────────── */

// An array of short strings, one input each. Stored exactly as the plain
// textarea-lines field would store it (blank rows dropped), so the widget
// reads it unchanged.
function buildListRow(field, item) {
    const row = document.createElement('div');
    row.className = 'editor-prop-row wf-list-row';
    row.appendChild(fieldLabel(field));

    const correct = field.correct?.key ? { key: field.correct.key, base: field.correct.base ?? 1 } : null;
    const list = document.createElement('div');
    list.className = 'wf-list' + (correct ? ' has-correct' : '');
    list.setAttribute('role', 'list');
    row.appendChild(list);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'wf-list-add';
    add.innerHTML = '<span aria-hidden="true">+</span> Add ' + escText((field.itemLabel || 'option').toLowerCase());
    row.appendChild(add);

    const initial = fieldValue(item, field);
    const values = Array.isArray(initial) ? initial.map(String)
                 : typeof initial === 'string' ? initial.split('\n') : [];
    // The stored correct answer points into the stored list, which never
    // holds blank rows — so it maps straight onto the rows built here.
    let correctRow = null;
    if (correct) {
        const n = parseInt(item[correct.key], 10);
        if (!isNaN(n) && n - correct.base >= 0 && n - correct.base < values.length) correctRow = n - correct.base;
    }

    const changed = () => list.dispatchEvent(new Event('input', { bubbles: true }));
    const inputs = () => Array.from(list.querySelectorAll('.wf-list-input'));

    function renumber() {
        inputs().forEach((inp, i) => {
            const r = inp.closest('.wf-list-item');
            r.querySelector('.wf-list-num').textContent = String(i + 1);
            inp.placeholder = field.itemPlaceholder ? `${field.itemPlaceholder} ${i + 1}` : '';
            const mark = r.querySelector('.wf-list-correct');
            if (mark) {
                const on = i === correctRow;
                mark.setAttribute('aria-pressed', on ? 'true' : 'false');
                mark.title = on ? 'Correct answer — click to unmark' : 'Mark as the correct answer';
                r.classList.toggle('is-correct', on);
            }
        });
        list.querySelectorAll('.wf-list-remove').forEach(b => { b.disabled = inputs().length <= 1; });
    }

    function makeItem(value) {
        const r = document.createElement('div');
        r.className = 'wf-list-item';
        r.setAttribute('role', 'listitem');
        const num = document.createElement('span');
        num.className = 'wf-list-num';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'editor-prop-input wf-list-input';
        inp.value = value;
        inp.spellcheck = false;
        r.appendChild(num);
        r.appendChild(inp);
        if (correct) {
            const mark = document.createElement('button');
            mark.type = 'button';
            mark.className = 'wf-list-correct';
            mark.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
            mark.addEventListener('click', () => {
                const i = inputs().indexOf(inp);
                correctRow = correctRow === i ? null : i;
                renumber(); changed();
            });
            r.appendChild(mark);
        }
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'wf-list-remove';
        rm.title = 'Remove';
        rm.setAttribute('aria-label', 'Remove');
        rm.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        rm.addEventListener('click', () => removeItem(inp, false));
        r.appendChild(rm);

        inp.addEventListener('keydown', (e) => {
            const all = inputs(), i = all.indexOf(inp);
            if (e.key === 'Enter') {
                e.preventDefault();
                const next = insertItemAfter(r, '');
                next.focus();
                changed();
            } else if (e.key === 'Backspace' && inp.value === '' && all.length > 1) {
                e.preventDefault();
                removeItem(inp, true);
            } else if (e.key === 'ArrowUp' && i > 0) {
                e.preventDefault(); all[i - 1].focus();
            } else if (e.key === 'ArrowDown' && i < all.length - 1) {
                e.preventDefault(); all[i + 1].focus();
            }
        });
        // Pasting several lines (answers copied from a document) fills
        // several rows rather than cramming them into one.
        inp.addEventListener('paste', (e) => {
            const text = e.clipboardData?.getData('text/plain') || '';
            if (!/\r?\n/.test(text)) return;
            e.preventDefault();
            const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            if (!lines.length) return;
            const { selectionStart: s = inp.value.length, selectionEnd: t = inp.value.length } = inp;
            inp.value = inp.value.slice(0, s) + lines[0] + inp.value.slice(t);
            let after = r;
            for (const line of lines.slice(1)) after = insertItemAfter(after, line).closest('.wf-list-item');
            after.querySelector('.wf-list-input').focus();
            changed();
        });
        return r;
    }

    function insertItemAfter(refRow, value) {
        const before = inputs().indexOf(refRow.querySelector('.wf-list-input'));
        const r = makeItem(value);
        refRow.after(r);
        // Rows after the insertion shift down one; keep the correct mark on
        // the same answer.
        if (correctRow != null && correctRow > before) correctRow++;
        renumber();
        return r.querySelector('.wf-list-input');
    }

    function removeItem(inp, focusPrev) {
        const all = inputs();
        if (all.length <= 1) { inp.value = ''; changed(); return; }
        const i = all.indexOf(inp);
        if (correctRow === i) correctRow = null;
        else if (correctRow != null && correctRow > i) correctRow--;
        inp.closest('.wf-list-item').remove();
        renumber();
        const rest = inputs();
        if (focusPrev) {
            const t = rest[Math.max(0, i - 1)];
            t.focus(); t.setSelectionRange(t.value.length, t.value.length);
        }
        changed();
    }

    // Start with room to type: at least two rows for a fresh widget.
    const start = values.length ? values : ['', ''];
    for (const v of start) list.appendChild(makeItem(v));
    renumber();

    add.addEventListener('click', () => {
        const all = inputs();
        const last = all[all.length - 1];
        // Reuse a trailing empty row instead of stacking blanks.
        const target = last && last.value === '' ? last : insertItemAfter(last.closest('.wf-list-item'), '');
        target.focus();
        changed();
    });

    return {
        key: field.key,
        node: row,
        wide: true,
        read() {
            const raw = inputs().map(i => i.value.trim());
            const kept = raw.filter(Boolean);
            const res = kept.length ? { value: kept } : { remove: true };
            if (correct) {
                // Position among the non-blank answers — that is the list the
                // widget actually receives.
                const ok = correctRow != null && raw[correctRow];
                const pos = ok ? raw.slice(0, correctRow).filter(Boolean).length : null;
                res.extra = { [correct.key]: pos == null ? { remove: true } : { value: pos + correct.base } };
            }
            return res;
        },
    };
}

/* ─── template editor ────────────────────────────────────────────────── */

// A code template with gaps. The textarea is transparent over a mirror that
// paints the same text, so every gap can be highlighted in place while the
// textarea still does all the actual editing (caret, selection, undo).
function buildTemplateRow(field, item, variant) {
    const eff = fieldValue(item, field);
    let pattern;
    try { pattern = new RegExp(field.blanks.pattern || '\\bBLANK\\b', 'g'); }
    catch (_) { pattern = /\bBLANK\b/g; }
    const token = field.blanks.insert || 'BLANK';

    const row = document.createElement('div');
    row.className = 'editor-prop-row wf-template';
    row.appendChild(fieldLabel(field));

    const bar = document.createElement('div');
    bar.className = 'wf-template-bar';
    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'wf-chip-btn';
    insert.title = `Insert ${token} at the cursor, or turn the selected text into one`;
    insert.innerHTML = `<span class="wf-blank-chip">${escText(token)}</span> Insert blank`;
    const count = document.createElement('span');
    count.className = 'wf-blank-count';
    bar.appendChild(insert);
    bar.appendChild(count);
    row.appendChild(bar);

    const box = document.createElement('div');
    box.className = 'wf-code';
    const mirror = document.createElement('div');
    mirror.className = 'wf-code-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    const ta = document.createElement('textarea');
    ta.className = 'wf-code-input';
    ta.rows = field.rows || 6;
    ta.spellcheck = false;
    ta.wrap = 'soft';
    if (field.placeholder) ta.placeholder = field.placeholder;
    ta.value = eff == null ? '' : String(eff);
    box.appendChild(mirror);
    box.appendChild(ta);
    row.appendChild(box);

    function paint() {
        const text = ta.value;
        let html = '', last = 0, n = 0;
        pattern.lastIndex = 0;
        for (let m; (m = pattern.exec(text)); ) {
            if (!m[0]) { pattern.lastIndex++; continue; }
            html += escText(text.slice(last, m.index)) + `<mark>${escText(m[0])}</mark>`;
            last = m.index + m[0].length;
            n++;
        }
        // A trailing newline needs something after it, or the mirror's last
        // line collapses and the highlights drift a line off.
        mirror.innerHTML = html + escText(text.slice(last)) + '​';
        count.textContent = n === 0 ? 'No blanks yet' : n === 1 ? '1 blank' : `${n} blanks`;
        count.classList.toggle('is-empty', n === 0);
        mirror.scrollTop = ta.scrollTop;
    }
    const grow = autoGrow(ta, variant);
    ta.addEventListener('input', paint);
    ta.addEventListener('scroll', () => { mirror.scrollTop = ta.scrollTop; });
    // Tab indents (it's code); Shift+Tab / Esc still leave the field.
    ta.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // mousedown, not click: keep the textarea's selection from collapsing
    // before we read it.
    insert.addEventListener('mousedown', (e) => e.preventDefault());
    insert.addEventListener('click', () => {
        const s = ta.selectionStart ?? ta.value.length, t = ta.selectionEnd ?? s;
        ta.focus();
        ta.setRangeText(token, s, t, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        grow();
    });

    paint();
    return {
        key: field.key,
        node: row,
        wide: true,
        read() { return ta.value === '' ? { remove: true } : { value: ta.value }; },
    };
}

/* ─── helpers ────────────────────────────────────────────────────────── */

function escText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The AI models the server can actually reach. main.js loads them at start-up;
// fall back to asking if that hasn't landed (or failed).
async function fillModelOptions(select, current) {
    const render = (models) => {
        select.textContent = '';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '— no model —';
        select.appendChild(none);
        for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (current === m) opt.selected = true;
            select.appendChild(opt);
        }
        // Keep a model the deck names but this server doesn't offer, so simply
        // opening the panel doesn't silently clear the presenter's choice.
        if (current && !models.includes(current)) {
            const opt = document.createElement('option');
            opt.value = current;
            opt.textContent = `${current} (unavailable)`;
            opt.selected = true;
            select.appendChild(opt);
        }
    };

    const known = ctx.state?.availableModels;
    if (Array.isArray(known) && known.length) { render(known); return; }

    const placeholder = document.createElement('option');
    placeholder.value = current == null ? '' : String(current);
    placeholder.textContent = current ? String(current) : '— loading… —';
    select.appendChild(placeholder);
    try {
        const data = await (await fetch(sessionUrl('/api/models'))).json();
        const models = data?.models || [];
        if (ctx.state) ctx.state.availableModels = models;
        render(models);
    } catch (_) {
        placeholder.textContent = '— unavailable —';
    }
}

// A file field's bytes go into the deck (and up to the server so the widget can
// read them before any save); the widget's config records only the path.
function pickWidgetAsset(field, item, input, btn) {
    const picker = document.createElement('input');
    picker.type = 'file';
    if (field.accept) picker.accept = field.accept;
    picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        if (!file) return;
        btn.disabled = true;
        btn.textContent = 'Uploading…';
        try {
            const buffer = await file.arrayBuffer();
            const path = await saveWidgetAsset(item, {
                key: field.key, name: file.name, folder: field.folder || 'files', buffer,
            });
            if (path) {
                input.value = path; input.title = path;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        } catch (err) {
            // The file is still recorded and will be written into the deck on
            // save — it is only the live preview that can't be served. Say so,
            // rather than leaving a silent failure to resurface later as a
            // missing file inside the widget.
            console.warn('[editor] widget file upload failed:', err);
            window.BeamerModal?.show({
                kind: 'error',
                title: 'Upload failed',
                message: `${err.message}\n\nThe file is still part of the presentation and will be included when you save, but the widget can't preview it until the upload succeeds.`,
            });
        } finally {
            btn.disabled = false;
            btn.textContent = 'Upload';
        }
    });
    picker.click();
}
