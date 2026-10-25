// The pen, the highlighter and the eraser's options.
//
// There is one pen and one highlighter. Choosing either (or the eraser)
// slides its options out beside the toolbar, the same flyout the text tool
// uses, and they stay out until you pick another tool:
//   pen, highlighter   size and colour (eight colours)
//   eraser             size
// Clicking the chosen pen again puts them away. Changes apply at once and
// are remembered on this computer.
import { bus } from '../core/events.js';

const PALETTE = [
    { name: 'Red',    c: '#e74c3c' },
    { name: 'Blue',   c: '#3498db' },
    { name: 'Green',  c: '#2ecc71' },
    { name: 'Yellow', c: '#f1c40f' },
    { name: 'Orange', c: '#f39c12' },
    { name: 'Purple', c: '#9b59b6' },
    { name: 'Brown',  c: '#8d6e63' },
    { name: 'Black',  c: '#333333' },
];
const IN_PALETTE = new Set(PALETTE.map(p => p.c));

// Slot 0 is the pen, slot 1 the highlighter.
const DEFAULT_PROFILES = [
    { mode: 'draw',      color: '#333333', size: 2, label: 'Pen' },
    { mode: 'highlight', color: '#f1c40f', size: 5, label: 'Highlighter' },
];
const ERASER_KEY = 'beamer-eraser-size';
const DEFAULT_ERASER = 2;

function _savePenProfiles(profiles) {
    try { localStorage.setItem('beamer-pen-profiles', JSON.stringify(profiles)); } catch {}
}

// What was saved, made to fit: the pen draws and the highlighter
// highlights, in one of the eight colours. (Older setups had five slots,
// either kind in any slot, and any colour.)
function _loadPenProfiles() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('beamer-pen-profiles') || 'null'); } catch {}
    if (!Array.isArray(saved) || !saved.length) return null;
    const fit = (mode, i) => {
        const p = saved.find(x => x?.mode === mode) ?? {};
        const d = DEFAULT_PROFILES[i];
        const color = String(p.color || '').toLowerCase();
        return {
            ...d,
            color: IN_PALETTE.has(color) ? color : d.color,
            size: [1, 2, 3, 4, 5].includes(p.size) ? p.size : d.size,
        };
    };
    const two = [fit('draw', 0), fit('highlight', 1)];
    _savePenProfiles(two);
    return two;
}

function _loadEraserSize() {
    try {
        const n = Number(localStorage.getItem(ERASER_KEY));
        return [1, 2, 3, 4, 5].includes(n) ? n : DEFAULT_ERASER;
    } catch { return DEFAULT_ERASER; }
}

export function initPenSlots(state) {
    // Load saved profiles (or fall back to defaults) — overrides whatever main.js seeded.
    state.penProfiles = _loadPenProfiles() ?? DEFAULT_PROFILES.map(p => ({ ...p }));
    state.eraserSize = _loadEraserSize();

    const container = document.getElementById('pen-slots');
    if (!container) return;
    const flyout = buildFlyout(state, container);
    let quiet = true;   // the first pen is chosen at start-up without its options

    state.penProfiles.forEach((pen, i) => {
        const btn = document.createElement('button');
        btn.className = 'btn pen-slot-btn tool-btn';
        btn.title = pen.mode === 'highlight' ? 'Highlighter' : 'Pen';
        btn.setAttribute('aria-label', btn.title);
        applyPenStyle(btn, pen, false);

        btn.addEventListener('click', (e) => {
            const wasSelected = btn.classList.contains('btn_selected');
            // Clear selection from all non-pen tool buttons (hand, eraser, etc.)
            document.querySelectorAll('#tool-container .tool-btn:not(.pen-slot-btn)').forEach(b => b.classList.remove('btn_selected'));
            container.querySelectorAll('.pen-slot-btn').forEach(b => b.classList.remove('btn_selected'));
            btn.classList.add('btn_selected');
            applyPenStyle(btn, pen, true);
            state.activePenSlot = i;
            bus.emit('pen:select', { ...pen, slot: i });
            if (quiet) return;
            // Clicking the chosen pen again puts its options away.
            if (e.detail > 0 && wasSelected && flyout.isOpenFor(i)) flyout.hide();
            else flyout.show(i);
        });

        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            btn.click();
            flyout.show(i);
        });

        container.appendChild(btn);
    });

    container.firstElementChild?.click();
    quiet = false;
}

const _PEN_SVG      = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
const _HIGHLIGHT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 11-6 6v3h3l6-6"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>`;

function applyPenStyle(btn, pen, selected) {
    btn.innerHTML = pen.mode === 'highlight' ? _HIGHLIGHT_SVG : _PEN_SVG;
    // Always keep the pen's color on the icon so it's visible selected or not
    btn.style.color = pen.color;
}

/* ─── the flyout: size and colour, or the eraser's size ────────────── */
// Built once and reused for whichever tool is open. Styled like the text
// tool's flyout (#text-size-sidebar), and placed the same way.
const PEN_DOT    = { 1: 4, 2: 7, 3: 10, 4: 14, 5: 18 };   // px, for the size dots
const ERASER_DOT = { 1: 6, 2: 9, 3: 12, 4: 16, 5: 20 };

function buildFlyout(state, container) {
    const el = document.createElement('div');
    el.id = 'pen-flyout';
    el.setAttribute('role', 'group');
    el.innerHTML = `
        ${[1, 2, 3, 4, 5].map(n => `<button class="btn" type="button" data-size="${n}" title="Size ${n}"><span class="pen-size-dot"></span></button>`).join('')}
        <hr class="text-flyout-sep" data-colors>
        <div class="text-color-row pen-color-row" role="group" aria-label="Color" data-colors>
            ${PALETTE.map(p => `<button class="text-color-swatch" type="button" data-color="${p.c}" title="${p.name}" aria-label="${p.name}" style="--c:${p.c}"></button>`).join('')}
        </div>`;
    document.body.appendChild(el);

    let open = null;   // the pen slot whose options are showing, or 'eraser'

    const sync = () => {
        const eraser = open === 'eraser';
        const p = eraser ? null : state.penProfiles[open];
        if (!eraser && !p) return;
        el.setAttribute('aria-label', eraser ? 'Eraser Size' : p.mode === 'highlight' ? 'Highlighter Options' : 'Pen Options');
        el.classList.toggle('is-eraser', eraser);
        el.querySelectorAll('[data-colors]').forEach(n => { n.hidden = eraser; });
        const size = eraser ? state.eraserSize : p.size;
        const dots = eraser ? ERASER_DOT : PEN_DOT;
        el.querySelectorAll('[data-size]').forEach(b => {
            const n = Number(b.dataset.size);
            b.classList.toggle('btn_selected', n === size);
            const dot = b.querySelector('.pen-size-dot');
            dot.style.width = dot.style.height = `${dots[n]}px`;
        });
        if (eraser) return;
        const c = String(p.color).toLowerCase();
        el.querySelectorAll('.text-color-swatch[data-color]').forEach(b => b.classList.toggle('is-selected', b.dataset.color === c));
    };

    // A change applies at once: the button, the tool in use, and what's saved.
    const change = (patch) => {
        if (open === 'eraser') {
            if (patch.size == null) return;
            state.eraserSize = patch.size;
            try { localStorage.setItem(ERASER_KEY, String(patch.size)); } catch {}
            bus.emit('eraser:size', patch.size);
            sync();
            return;
        }
        const p = state.penProfiles[open];
        if (!p) return;
        Object.assign(p, patch);
        _savePenProfiles(state.penProfiles);
        const btn = container.children[open];
        if (btn) applyPenStyle(btn, p, btn.classList.contains('btn_selected'));
        if (state.activePenSlot === open) bus.emit('pen:select', { ...p, slot: open });
        sync();
    };

    el.querySelectorAll('[data-size]').forEach(b => b.addEventListener('click', () => change({ size: Number(b.dataset.size) })));
    el.querySelectorAll('.text-color-swatch[data-color]').forEach(b => b.addEventListener('click', () => change({ color: b.dataset.color })));

    const hide = () => {
        if (open === null) return;
        open = null;
        el.style.display = 'none';
        document.body.classList.remove('pen-flyout-open');
    };
    const show = (which) => {
        open = which;
        sync();
        el.style.display = 'flex';
        document.body.classList.add('pen-flyout-open');
    };

    // Out until another tool is picked: the eraser brings up its own size,
    // anything else puts the flyout away. (Drawing doesn't.)
    bus.on('tool:change', (t) => {
        if (t === 'eraser') show('eraser');
        else if (t && t !== 'pen' && t !== 'draw' && t !== 'highlight') hide();
    });

    return { show, hide, isOpenFor: (i) => open === i };
}
