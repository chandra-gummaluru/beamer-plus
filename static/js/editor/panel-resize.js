// The editor panel's width: drag its left edge to make it wider or narrower
// (double-click the edge for the default). Remembered in this browser.
// The stage refits as it changes (main.js listens for 'resize').

const KEY = 'beamer.editor.panelWidth';
const DEFAULT = 320, MIN = 260;
const maxWidth = () => Math.max(MIN, Math.min(720, Math.round(window.innerWidth * 0.6)));
const clamp = w => Math.round(Math.max(MIN, Math.min(maxWidth(), w)));

function apply(w) {
    document.documentElement.style.setProperty('--editor-panel-width', `${w}px`);
}
function saved() {
    try { const n = Number(localStorage.getItem(KEY)); return n > 0 ? n : DEFAULT; } catch { return DEFAULT; }
}
function remember(w) {
    try { if (w === DEFAULT) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(w)); } catch { /* ignore */ }
}

export function initPanelResize() {
    const panel = document.getElementById('editor-panel');
    if (!panel) return;
    let width = clamp(saved());
    apply(width);

    const grip = document.createElement('div');
    grip.id = 'editor-panel-resize';
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'vertical');
    grip.setAttribute('aria-label', 'Resize the editor panel');
    grip.title = 'Drag to resize · double-click to reset';
    grip.tabIndex = 0;
    panel.appendChild(grip);

    let raf = 0;
    const refit = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; window.dispatchEvent(new Event('resize')); });
    };
    const set = (w, { save = false } = {}) => {
        width = clamp(w);
        apply(width);
        grip.setAttribute('aria-valuenow', String(width));
        refit();
        if (save) remember(width);
    };

    grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        document.body.classList.add('is-resizing-editor');
        const startX = e.clientX, startW = width;
        const move = (ev) => set(startW + (startX - ev.clientX));
        const up = () => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', up);
            grip.removeEventListener('pointercancel', up);
            document.body.classList.remove('is-resizing-editor');
            remember(width);
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => set(DEFAULT, { save: true }));
    grip.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); set(width + step, { save: true }); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); set(width - step, { save: true }); }
    });
    // A smaller window can't keep a panel wider than 60% of it.
    window.addEventListener('resize', () => {
        const w = clamp(width);
        if (w !== width) { width = w; apply(w); }
    });
}
