// A widget's own settings, in a sheet opened from the widget itself.
//
// Every widget is self-contained: its specific settings (a poll's question,
// a timer's duration, a video's link…) are edited from the pencil that shows
// in the widget's top bar while the pointer is over it (or, laid over part of
// a slide without a bar, in its corner). The editor's panel keeps only what
// every widget has — Name, Text size and where it sits (widget-panel.js).
//
// Protocol
//   ← widget   widget-edit-settings   { widgetId }   open the sheet
//   → widget   widget-config          { config, live: true }   (live widgets)
//
// The sheet docks to the right of the window rather than covering the slide,
// so the widget stays in view while it's being set up. Changes go onto the
// widget's config item as they're made, and then:
//
//   - a widget whose schema declares "liveSettings": true is handed its new
//     config as you type (debounced) and updates in place — a running poll,
//     a timer's progress, a notebook's cells all survive;
//   - any other widget, or one where a field marked "rebuild": true changed,
//     is rebuilt with its new settings when the sheet closes.
import { bus } from '../core/events.js';
import { widgetIdForWindow, pushWidgetConfig } from '../core/iframe-widget-renderer.js';
import { getWidgetSchema } from './widget-schema.js';
import { buildWidgetForm } from './widget-fields.js';
import { enhanceSelects } from './dropdown.js';
import { findWidgetItem } from './widget-settings.js';

// What the editor panel edits instead (widget-panel.js).
export const GENERAL_KEYS = new Set(['title', 'scale']);

/** The widget's own fields: everything but Name and Text size. */
export const ownFields = (schema) => (schema?.fields || []).filter(f => !GENERAL_KEYS.has(f.key));

// Long enough that a burst of typing is one update, short enough to feel live.
const PUSH_DELAY = 250;

const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

let _open = null;   // the sheet on screen: { id, item, node, … } — one at a time
let _token = 0;     // the schema read is async; only the latest open wins

export function initWidgetSettingsDialog() {
    window.addEventListener('message', (e) => {
        if (e.data?.type !== 'widget-edit-settings') return;
        // Only from one of our own widget iframes, speaking for itself.
        const id = widgetIdForWindow(e.source);
        if (id === null || id !== String(e.data.widgetId)) return;
        openWidgetSettings(id);
    });
    // Leaving the slide (or the deck) takes the widget away; entering the
    // editor closes the sheet too (editor.js).
    // A reveal step re-announces the same slide, so only close once no copy
    // of the widget is on screen any more (a parked one has opacity 0).
    bus.on('slide:changed', () => {
        if (!_open) return;
        const shown = Array.from(document.querySelectorAll(`.widget-iframe[data-widget-id="${CSS.escape(_open.id)}"]`))
            .some(f => f.isConnected && f.style.opacity !== '0');
        if (!shown) closeWidgetSettings();
    });
    for (const ev of ['deck:loaded', 'session:ending']) bus.on(ev, () => closeWidgetSettings());
}

export async function openWidgetSettings(widgetId) {
    const id = String(widgetId);
    // The same pencil again: the sheet is already there — bring focus back.
    if (_open?.id === id) { _open.form.focusFirst?.(); return; }

    const token = ++_token;
    const item = findWidgetItem(id);
    if (!item) return;
    const schema = await getWidgetSchema(item);
    if (token !== _token) return;
    closeWidgetSettings();

    const fields = ownFields(schema);
    const name = item.title || schema?.label || 'Widget';
    if (!fields.length) {
        window.BeamerModal?.show({ kind: 'info', title: `${name} Settings`, message: 'This widget has no settings of its own.' });
        return;
    }

    const live = !!schema.liveSettings;
    const rebuildKeys = fields.filter(f => f.rebuild).map(f => f.key);
    const snap = () => JSON.stringify(item);
    const pick = (keys) => JSON.stringify(keys.map(k => item[k]));
    const before = snap();
    const rebuildBefore = pick(rebuildKeys);

    const form = buildWidgetForm({ ...schema, fields }, item, 'sheet');
    const node = buildSheet(name, schema?.label, live, form.node);
    enhanceSelects(form.node);

    const state = { id, item, node, form, live, timer: null, pushedSig: before };

    const push = () => {
        clearTimeout(state.timer);
        state.timer = null;
        const sig = snap();
        if (sig === state.pushedSig) return;
        state.pushedSig = sig;
        pushWidgetConfig(id, item);
    };
    const apply = () => {
        form.apply(item);
        form.syncVisibility();
        node.querySelector('.wsheet-title').textContent = `${item.title || schema?.label || 'Widget'} Settings`;
        if (!live) return;
        clearTimeout(state.timer);
        state.timer = setTimeout(push, PUSH_DELAY);
    };
    form.node.addEventListener('input', apply);
    form.node.addEventListener('change', apply);

    state.close = () => {
        apply();
        clearTimeout(state.timer);
        const changed = snap() !== before;
        const needsRebuild = !live || pick(rebuildKeys) !== rebuildBefore;
        if (changed && !needsRebuild) push();
        // Rebuild only if something actually changed and couldn't go in live.
        if (changed && needsRebuild) bus.emit('widgets:changed');
    };

    state.onKey = (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        // Let an open expanded editor or dropdown take its own Escape first.
        if (document.querySelector('.wf-xe-overlay.is-open')) return;
        e.preventDefault();
        closeWidgetSettings();
    };
    document.addEventListener('keydown', state.onKey);
    node.querySelector('.wsheet-close').addEventListener('click', () => closeWidgetSettings());
    node.querySelector('.wsheet-done').addEventListener('click', () => closeWidgetSettings());

    _open = state;
    document.body.appendChild(node);
    markWidget(id, true);
    makeRoom(true);
    // Next frame, so the slide-in transition has a starting point.
    requestAnimationFrame(() => node.classList.add('is-open'));
    setTimeout(() => form.focusFirst?.(), 60);
}

export function closeWidgetSettings() {
    const s = _open;
    if (!s) return;
    _open = null;
    document.removeEventListener('keydown', s.onKey);
    try { s.close(); } finally {
        markWidget(s.id, false);
        s.node.classList.remove('is-open');
        makeRoom(false);
        const gone = () => s.node.remove();
        s.node.addEventListener('transitionend', gone, { once: true });
        setTimeout(gone, 320);   // reduced motion: no transition to wait for
    }
}

/* ─── the sheet ─────────────────────────────────────────────────── */

function buildSheet(name, kind, live, body) {
    const node = document.createElement('aside');
    node.className = 'wsheet';
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', `${name} Settings`);

    const head = document.createElement('header');
    head.className = 'wsheet-head';
    const titles = document.createElement('div');
    titles.className = 'wsheet-titles';
    const title = document.createElement('h2');
    title.className = 'wsheet-title';
    title.textContent = `${name} Settings`;
    titles.appendChild(title);
    // The widget's kind under a custom name ("Exit ticket" → Audience Response).
    if (kind && kind !== name) {
        const sub = document.createElement('div');
        sub.className = 'wsheet-kind';
        sub.textContent = kind;
        titles.appendChild(sub);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'wsheet-close';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = CLOSE_ICON;
    head.append(titles, close);

    const scroll = document.createElement('div');
    scroll.className = 'wsheet-body';
    scroll.appendChild(body);

    const foot = document.createElement('footer');
    foot.className = 'wsheet-foot';
    const hint = document.createElement('span');
    hint.className = 'wsheet-hint';
    hint.innerHTML = live
        ? '<span class="wsheet-live-dot" aria-hidden="true"></span>Changes apply as you edit'
        : 'Changes apply when you close this';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'wsheet-done';
    done.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg><span>Done</span>';
    foot.append(hint, done);

    node.append(head, scroll, foot);
    return node;
}

// Slide the stage over to make room, the way the editor's panel does, so
// the sheet sits beside the slide instead of over the widget it's editing.
// The slide re-fits on `resize` (main.js), and the widgets with it.
function makeRoom(on) {
    document.body.classList.toggle('wsheet-open', on);
    window.dispatchEvent(new Event('resize'));
}

// Outline the widget being edited, so it's clear which one the sheet is for
// (a slide may hold several).
function markWidget(id, on) {
    document.querySelectorAll(`.widget-iframe[data-widget-id="${CSS.escape(id)}"]`)
        .forEach(f => f.classList.toggle('is-being-configured', on));
}
