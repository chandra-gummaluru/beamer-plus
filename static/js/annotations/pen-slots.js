// Pen slots — click a pen to select it; its options (pen or highlighter,
// size, colour) slide out beside the toolbar, the same flyout the text tool
// uses. Clicking the selected pen again, drawing, or picking another tool
// puts the flyout away. Changes apply straight away and are remembered.
import { bus } from '../core/events.js';

const DEFAULT_PROFILES = [
    { mode: 'draw',      color: '#333333', size: 2, label: 'P1' },
    { mode: 'draw',      color: '#e74c3c', size: 2, label: 'P2' },
    { mode: 'highlight', color: '#f1c40f', size: 5, label: 'H1' },
    { mode: 'highlight', color: '#2ecc71', size: 5, label: 'H2' },
    { mode: 'draw',      color: '#3498db', size: 2, label: 'P3' },
];

const PEN_SWATCHES = ['#eeeeee','#e74c3c','#f1c40f','#2ecc71','#3498db','#9b59b6','#333333'];

function _savePenProfiles(profiles) {
    try { localStorage.setItem('beamer-pen-profiles', JSON.stringify(profiles)); } catch {}
}

function _loadPenProfiles() {
    try {
        const saved = JSON.parse(localStorage.getItem('beamer-pen-profiles') || 'null');
        if (Array.isArray(saved) && saved.length > 0) return saved;
    } catch {}
    return null;
}

export function initPenSlots(state) {
    // Load saved profiles (or fall back to defaults) — overrides whatever main.js seeded.
    state.penProfiles = _loadPenProfiles() ?? DEFAULT_PROFILES.map(p => ({ ...p }));

    const container = document.getElementById('pen-slots');
    if (!container) return;
    const flyout = buildFlyout(state, container);

    state.penProfiles.forEach((pen, i) => {
        const btn = document.createElement('button');
        btn.className = 'btn pen-slot-btn tool-btn';
        btn.title = `Pen ${i + 1}`;
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
            // Only a real click opens the options (not a keyboard shortcut or
            // a tool being restored from code); clicking it again closes them.
            if (e.detail === 0) return;
            if (wasSelected && flyout.isOpenFor(i)) flyout.hide();
            else flyout.show(i);
        });

        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            btn.click();
            flyout.show(i);
        });

        container.appendChild(btn);
    });

    // Select first slot (quietly: no flyout)
    container.firstElementChild?.click();
}

const _PEN_SVG      = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
const _HIGHLIGHT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 11-6 6v3h3l6-6"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>`;

function applyPenStyle(btn, pen, selected) {
    btn.innerHTML = pen.mode === 'highlight' ? _HIGHLIGHT_SVG : _PEN_SVG;
    // Always keep the pen's color on the icon so it's visible selected or not
    btn.style.color = pen.color;
}

/* ─── the flyout: pen / highlighter, size, colour ──────────────────── */
// Built once and reused for whichever pen is open. Styled like the text
// tool's flyout (#text-size-sidebar), and placed the same way.
const PEN_DOT = { 1: 4, 2: 7, 3: 10, 4: 14, 5: 18 };   // px, for the size dots

function buildFlyout(state, container) {
    const el = document.createElement('div');
    el.id = 'pen-flyout';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Pen options');
    el.innerHTML = `
        <button class="btn" type="button" data-mode="draw" title="Pen">${_PEN_SVG}</button>
        <button class="btn" type="button" data-mode="highlight" title="Highlighter">${_HIGHLIGHT_SVG}</button>
        <hr class="text-flyout-sep">
        ${[1, 2, 3, 4, 5].map(n => `<button class="btn" type="button" data-size="${n}" title="Size ${n}"><span class="pen-size-dot" style="width:${PEN_DOT[n]}px;height:${PEN_DOT[n]}px"></span></button>`).join('')}
        <hr class="text-flyout-sep">
        <div class="text-color-row" role="group" aria-label="Pen color">
            ${PEN_SWATCHES.map(c => `<button class="text-color-swatch" type="button" data-color="${c}" title="${c}" style="--c:${c}"></button>`).join('')}
            <label class="text-color-swatch text-color-custom" title="Pick any color">
                <input type="color" value="#333333" aria-label="Pick any color">
            </label>
        </div>`;
    document.body.appendChild(el);

    let open = null;   // index of the pen whose options are showing

    const sync = () => {
        const p = state.penProfiles[open];
        if (!p) return;
        el.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('btn_selected', b.dataset.mode === p.mode));
        el.querySelectorAll('[data-size]').forEach(b => b.classList.toggle('btn_selected', Number(b.dataset.size) === p.size));
        const c = String(p.color).toLowerCase();
        let preset = false;
        el.querySelectorAll('.text-color-swatch[data-color]').forEach(b => {
            const on = b.dataset.color.toLowerCase() === c;
            b.classList.toggle('is-selected', on);
            if (on) preset = true;
        });
        const custom = el.querySelector('.text-color-custom');
        custom.classList.toggle('is-selected', !preset);
        custom.style.setProperty('--c', c);
        if (/^#[0-9a-f]{6}$/.test(c)) custom.querySelector('input').value = c;
    };

    // A change applies at once: the button, the pen in use, and what's saved.
    const change = (patch) => {
        const p = state.penProfiles[open];
        if (!p) return;
        Object.assign(p, patch);
        _savePenProfiles(state.penProfiles);
        const btn = container.children[open];
        if (btn) applyPenStyle(btn, p, btn.classList.contains('btn_selected'));
        if (state.activePenSlot === open) bus.emit('pen:select', { ...p, slot: open });
        sync();
    };

    el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => change({ mode: b.dataset.mode })));
    el.querySelectorAll('[data-size]').forEach(b => b.addEventListener('click', () => change({ size: Number(b.dataset.size) })));
    el.querySelectorAll('.text-color-swatch[data-color]').forEach(b => b.addEventListener('click', () => change({ color: b.dataset.color })));
    const picker = el.querySelector('.text-color-custom input');
    picker.addEventListener('input', () => change({ color: picker.value }));

    const hide = () => {
        if (open === null) return;
        open = null;
        el.style.display = 'none';
        document.body.classList.remove('pen-flyout-open');
    };
    const show = (i) => {
        open = i;
        sync();
        el.style.display = 'flex';
        document.body.classList.add('pen-flyout-open');
    };

    // Put away by anything else: drawing on the slide, another tool, the
    // toolbar's other buttons. (Not by its own pen button — that toggles.)
    document.addEventListener('pointerdown', (e) => {
        if (open === null) return;
        if (el.contains(e.target) || e.target.closest?.('.pen-slot-btn')) return;
        hide();
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open !== null) hide(); });
    bus.on('tool:change', (t) => { if (t && t !== 'pen' && t !== 'draw' && t !== 'highlight') hide(); });

    return { show, hide, isOpenFor: (i) => open === i };
}
