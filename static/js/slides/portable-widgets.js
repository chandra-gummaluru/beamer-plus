// Portable widgets — a calculator, a timer, … brought up from the annotation
// toolbar at any moment, without putting a widget on a slide.
//
// The toolbar's Portable Widgets button opens a small menu of every widget
// that is portable (/api/widgets/catalog `portable`: the schema says
// "portable": true, or by default the widget has an overlay mode). Picking one
// opens it in a small window that floats over the stage: dragged by its title
// bar, resized from its corner, closed with its ×. One window per widget type;
// picking it again brings that window to the front.
//
// A window belongs to the presenter's screen, not to the deck: it stays open
// across slides and edit mode, is never saved, and is not sent to the audience.
// Its iframe is deliberately not a `.widget-iframe`, so the slide machinery
// (parking, state collection for the save, settings written back to a slide)
// never sees it. The widget runs in its overlay display, as on a slide.
import { widgetCatalog, widgetIcon } from '../editor/widget-picker.js';
import { builtinWidgetSrcdoc } from '../core/iframe-widget-renderer.js';
import { escHtml } from '../editor/context.js';

const MIN_W = 180, MIN_H = 120;     // px, the body (below the title bar)
const BAR_H = 30;                   // px, the title bar
const DEFAULT_SIZE = { width: 0.28, height: 0.32 };   // of the stage, without an overlaySize

const _open = new Map();            // type → { win, iframe, saved }
let _z = 0;

export function initPortableWidgets() {
    const btn = document.getElementById('portable-widgets-btn');
    if (!btn) return;
    const menu = _buildMenu(btn);
    btn.addEventListener('click', () => (menu.isOpen() ? menu.hide() : menu.show()));

    // Edit mode on the widget (its Edit button) asks to grow; a window has
    // no slide to grow to, so it grows itself, and shrinks back after.
    window.addEventListener('message', (e) => {
        const t = e.data?.type;
        if (t !== 'widget-expand' && t !== 'widget-collapse') return;
        const entry = [..._open.values()].find(o => o.iframe.contentWindow === e.source);
        if (!entry) return;
        if (t === 'widget-expand') _grow(entry); else _shrink(entry);
    });
}

/* ─── the menu ─────────────────────────────────────────────────── */

function _buildMenu(btn) {
    const el = document.createElement('div');
    el.id = 'portable-flyout';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'Portable Widgets');
    document.body.appendChild(el);
    let open = false;

    const fill = async () => {
        const list = (await widgetCatalog()).filter(w => w.portable);
        el.innerHTML = list.length
            ? list.map(w => `<button class="btn portable-item" type="button" role="menuitem" data-type="${escHtml(w.type)}" title="${escHtml(w.label)}">
                    <span class="portable-item-icon">${widgetIcon(w.type)}</span><span>${escHtml(w.label)}</span></button>`).join('')
            : '<div class="portable-empty">No portable widgets.</div>';
        el.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
            hide();
            const w = list.find(x => x.type === b.dataset.type);
            if (w) openPortableWidget(w);
        }));
    };

    const place = () => {
        const r = btn.getBoundingClientRect();
        const m = el.getBoundingClientRect();
        const vertical = btn.closest('#floating-annotation-toolbar')
            ?.getBoundingClientRect().height > btn.closest('#floating-annotation-toolbar')?.getBoundingClientRect().width;
        let left, top;
        if (vertical) {            // the rail on the right: the menu to its left
            left = r.left - m.width - 12;
            top  = r.top + r.height / 2 - m.height / 2;
        } else {                   // the bar along the top (split view) or bottom
            left = r.left + r.width / 2 - m.width / 2;
            top  = r.bottom + 12;
            if (top + m.height > innerHeight - 8) top = r.top - m.height - 12;
        }
        el.style.left = `${Math.max(8, Math.min(left, innerWidth - m.width - 8))}px`;
        el.style.top  = `${Math.max(8, Math.min(top, innerHeight - m.height - 8))}px`;
    };

    const onDoc = (e) => { if (!el.contains(e.target) && !btn.contains(e.target)) hide(); };
    const onKey = (e) => { if (e.key === 'Escape') hide(); };

    async function show() {
        await fill();
        open = true;
        el.style.display = 'flex';
        place();
        btn.classList.add('btn_selected');
        btn.setAttribute('aria-expanded', 'true');
        document.addEventListener('pointerdown', onDoc, true);
        document.addEventListener('keydown', onKey);
        addEventListener('resize', hide);
    }
    function hide() {
        if (!open) return;
        open = false;
        el.style.display = 'none';
        btn.classList.remove('btn_selected');
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onDoc, true);
        document.removeEventListener('keydown', onKey);
        removeEventListener('resize', hide);
    }
    return { show, hide, isOpen: () => open };
}

/* ─── the windows ──────────────────────────────────────────────── */

/** Open (or bring to the front) the portable window of a catalog entry. */
export async function openPortableWidget(entry) {
    const existing = _open.get(entry.type);
    if (existing) { _front(existing.win); return; }

    const stage = document.getElementById('main-content')?.getBoundingClientRect();
    const sw = stage?.width || innerWidth, sh = stage?.height || innerHeight;
    const frac = entry.overlaySize || DEFAULT_SIZE;
    const w = _clamp(Math.round((frac.width || DEFAULT_SIZE.width) * sw), MIN_W, innerWidth * 0.9);
    const h = _clamp(Math.round((frac.height || DEFAULT_SIZE.height) * sh), MIN_H, innerHeight * 0.85 - BAR_H);
    // Cascade from the top right, clear of the annotation rail.
    const n = _open.size;
    const left = _clamp(innerWidth - w - 96 - n * 28, 8, innerWidth - w - 8);
    const top  = _clamp(72 + n * 28, 8, innerHeight - h - BAR_H - 8);

    const win = document.createElement('div');
    win.className = 'portable-win';
    win.dataset.type = entry.type;
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', entry.label);
    win.innerHTML = `
        <div class="portable-bar">
            <span class="portable-bar-icon">${widgetIcon(entry.type)}</span>
            <span class="portable-bar-title">${escHtml(entry.label)}</span>
            <button class="portable-close" type="button" title="Close" aria-label="Close ${escHtml(entry.label)}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
        <div class="portable-body"><iframe title="${escHtml(entry.label)}" allow="autoplay; fullscreen"></iframe></div>
        <div class="portable-grip" title="Resize" aria-hidden="true"></div>`;
    Object.assign(win.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h + BAR_H}px` });
    document.body.appendChild(win);

    const iframe = win.querySelector('iframe');
    const record = { win, iframe, saved: null };
    _open.set(entry.type, record);
    _front(win);

    win.addEventListener('pointerdown', () => _front(win), true);
    win.querySelector('.portable-close').addEventListener('click', () => closePortableWidget(entry.type));
    _dragBy(win.querySelector('.portable-bar'), win, 'move');
    _dragBy(win.querySelector('.portable-grip'), win, 'resize');

    try {
        const { srcdoc, config } = await builtinWidgetSrcdoc(entry.type, {
            id: `portable-${entry.type}`, type: entry.type, builtin: true, portable: true,
            display: 'overlay', x: 0, y: 0, width: 1, height: 1, zIndex: 1,
        });
        iframe.addEventListener('load', () => {
            try { iframe.contentWindow?.postMessage({ type: 'widget-config', config }, '*'); } catch (_) {}
        }, { once: true });
        iframe.srcdoc = srcdoc;
    } catch (err) {
        console.error('[portable] could not open', entry.type, err);
        iframe.srcdoc = `<div style="padding:16px;font-family:sans-serif;color:#c0392b">Could not open ${escHtml(entry.label)}.</div>`;
    }
}

export function closePortableWidget(type) {
    const o = _open.get(type);
    if (!o) return;
    _open.delete(type);
    try { o.iframe.contentWindow?.postMessage({ type: 'widget-cleanup' }, '*'); } catch (_) {}
    o.win.remove();
}

function _front(win) { win.dataset.order = String(++_z); _restack(); }
// All windows share one z-index band (above the slide and ink, below the
// toolbar's flyouts and any dialog); their order within it follows clicks.
function _restack() {
    [..._open.values()].map(o => o.win)
        .sort((a, b) => Number(a.dataset.order || 0) - Number(b.dataset.order || 0))
        .forEach((w, i) => { w.style.zIndex = String(552 + Math.min(i, 5)); });
}

// Drag the title bar to move, the corner grip to resize. The iframes stop
// taking the pointer meanwhile, or one passed over would swallow the drag.
function _dragBy(handle, win, kind) {
    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('.portable-close')) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const r = win.getBoundingClientRect();
        const sx = e.clientX, sy = e.clientY;
        document.body.classList.add('portable-dragging');
        const move = (ev) => {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (kind === 'move') {
                win.style.left = `${_clamp(r.left + dx, 40 - r.width, innerWidth - 40)}px`;
                win.style.top  = `${_clamp(r.top + dy, 0, innerHeight - BAR_H)}px`;
            } else {
                win.style.width  = `${_clamp(r.width + dx, MIN_W, innerWidth - r.left - 4)}px`;
                win.style.height = `${_clamp(r.height + dy, MIN_H + BAR_H, innerHeight - r.top - 4)}px`;
            }
        };
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            document.body.classList.remove('portable-dragging');
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    });
}

function _grow(o) {
    if (o.saved) return;
    const s = o.win.style;
    o.saved = { left: s.left, top: s.top, width: s.width, height: s.height };
    const w = Math.min(720, innerWidth * 0.9), h = Math.min(520, innerHeight * 0.85);
    Object.assign(s, { left: `${(innerWidth - w) / 2}px`, top: `${(innerHeight - h) / 2}px`, width: `${w}px`, height: `${h}px` });
    _front(o.win);
}
function _shrink(o) {
    if (!o.saved) return;
    Object.assign(o.win.style, o.saved);
    o.saved = null;
}

function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
