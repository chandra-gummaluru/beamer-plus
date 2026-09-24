// Widget settings dialog — where a widget is configured.
//
// Opened from the slide's "On this slide" list, the "Edit settings" button,
// a double-click on the widget, or right after adding one (see
// openWidgetSettingsFor in properties.js). It holds everything about the
// widget: its own settings (form from widget-fields.js, as cards in two
// columns), a Layout card for its box on the slide, and Remove. Every change
// is applied to the config item live, so there is nothing to save or cancel.
import { buildWidgetForm } from './widget-fields.js';

let _open = null;   // { overlay, onKey, restoreFocus, onClose }

export function isWidgetSettingsOpen() { return !!_open; }

/**
 * @param {object} item     the widget's config item (edited in place)
 * @param {object} schema   from getWidgetSchema(item)
 * @param {object} opts
 * @param {string} opts.title       e.g. "Audience Response"
 * @param {() => void} opts.onChange  after each applied settings edit
 * @param {() => void} opts.onLayout  after a Layout edit (reposition the box)
 * @param {() => void} opts.onRemove  Remove was chosen — delete the widget
 * @param {(removed:boolean) => void} opts.onClose  after the dialog is gone
 */
export function openWidgetSettings(item, schema, { title, onChange, onLayout, onRemove, onClose } = {}) {
    closeWidgetSettings();

    const overlay = document.createElement('div');
    overlay.className = 'wsm-overlay';
    overlay.innerHTML = `
        <div class="wsm-dialog" role="dialog" aria-modal="true" aria-labelledby="wsm-title">
            <header class="wsm-header">
                <div class="wsm-heading">
                    <div class="wsm-kicker">Widget settings</div>
                    <h2 class="wsm-title" id="wsm-title"></h2>
                </div>
                <button type="button" class="wsm-close" title="Close (Esc)" aria-label="Close">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </header>
            <div class="wsm-body"></div>
            <footer class="wsm-footer">
                <button type="button" class="btn wsm-remove">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                    Remove widget
                </button>
                <button type="button" class="btn wsm-done">Done</button>
            </footer>
        </div>`;
    overlay.querySelector('.wsm-title').textContent = title || schema.label || 'Widget';

    const form = buildWidgetForm(schema, item, 'modal');
    const body = overlay.querySelector('.wsm-body');
    body.appendChild(form.node);

    // The box on the slide, as a card under the short settings (or on its
    // own, for a widget with nothing else to configure).
    const layout = buildLayoutCard(item, () => onLayout?.());
    let side = form.node.querySelector(':scope > .wf-col--side');
    if (!side) {
        side = document.createElement('div');
        side.className = 'wf-col wf-col--side';
        form.node.appendChild(side);
    }
    side.appendChild(layout);
    if (!schema.fields.length) {
        const none = document.createElement('div');
        none.className = 'editor-prop-hint wsm-empty';
        none.textContent = 'This widget has no settings of its own — only its place on the slide.';
        side.prepend(none);
    }
    form.syncVisibility();

    const apply = (e) => {
        if (layout.contains(e.target)) return;   // handled by the card itself
        form.apply(item); form.syncVisibility(); onChange?.();
    };
    body.addEventListener('input', apply);
    body.addEventListener('change', apply);

    overlay.querySelector('.wsm-done').addEventListener('click', () => closeWidgetSettings());
    overlay.querySelector('.wsm-close').addEventListener('click', () => closeWidgetSettings());
    const removeBtn = overlay.querySelector('.wsm-remove');
    if (onRemove) {
        // Two clicks: the first arms it, so a stray click can't lose a
        // configured widget (there is no undo for this).
        removeBtn.addEventListener('click', () => {
            if (!removeBtn.classList.contains('is-armed')) {
                removeBtn.classList.add('is-armed');
                removeBtn.lastChild.textContent = ' Click again to remove';
                setTimeout(() => {
                    if (!removeBtn.isConnected) return;
                    removeBtn.classList.remove('is-armed');
                    removeBtn.lastChild.textContent = ' Remove widget';
                }, 3000);
                return;
            }
            closeWidgetSettings(true);
            onRemove();
        });
    } else removeBtn.hidden = true;
    // A click on the backdrop itself (not a drag that merely ends there).
    let downOnBackdrop = false;
    overlay.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === overlay; });
    overlay.addEventListener('click', (e) => {
        if (downOnBackdrop && e.target === overlay) closeWidgetSettings();
    });

    // Capture phase on window: Esc must close this dialog and nothing else
    // (the editor would otherwise also deselect the widget), and the slide
    // shortcuts must not fire while typing in here.
    const onKey = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault(); e.stopImmediatePropagation();
            closeWidgetSettings();
            return;
        }
        // (Tab inside a code template indents instead — see widget-fields.js.)
        if (e.key === 'Tab' && !(e.target.classList?.contains('wf-code-input') && !e.shiftKey)) trapTab(e, overlay);
        // Keys typed into the dialog belong to the dialog.
        if (overlay.contains(e.target)) e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);

    _open = { overlay, onKey, restoreFocus: document.activeElement, onClose };
    document.body.appendChild(overlay);
    document.body.classList.add('wsm-open');
    requestAnimationFrame(() => {
        overlay.classList.add('is-open');
        form.focusFirst();
    });
}

export function closeWidgetSettings(removed = false) {
    if (!_open) return;
    const { overlay, onKey, restoreFocus, onClose } = _open;
    _open = null;
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
    document.body.classList.remove('wsm-open');
    try { restoreFocus?.isConnected && restoreFocus.focus?.(); } catch (_) {}
    onClose?.(removed);
}

// Position, size and layer of the widget's box on the slide, in percent of
// the slide (as the sidebar shows them). Written to the item as fractions.
function buildLayoutCard(item, onLayout) {
    const card = document.createElement('section');
    card.className = 'wf-group wsm-layout';
    const pct = (v, d) => Math.round((v ?? d) * 100);
    card.innerHTML = `
        <div class="wf-group-title">Layout</div>
        <div class="wf-group-body">
            <div class="wsm-layout-presets">
                <button type="button" class="wsm-preset" data-preset="full" title="Cover the whole slide">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="6" y="7" width="12" height="10" rx="1" fill="currentColor" fill-opacity=".18"/></svg>
                    Fill slide
                </button>
                <button type="button" class="wsm-preset" data-preset="center" title="Keep the size, move to the middle">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="8.5" y="9" width="7" height="6" rx="1" fill="currentColor" fill-opacity=".18"/><line x1="12" y1="4" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="20"/></svg>
                    Center
                </button>
            </div>
            <div class="editor-prop-row-2col">
                <label class="editor-prop-row"><span class="editor-prop-label">X (%)</span>
                    <input class="editor-prop-input" type="number" min="0" max="100" step="1" data-k="x"></label>
                <label class="editor-prop-row"><span class="editor-prop-label">Y (%)</span>
                    <input class="editor-prop-input" type="number" min="0" max="100" step="1" data-k="y"></label>
                <label class="editor-prop-row"><span class="editor-prop-label">Width (%)</span>
                    <input class="editor-prop-input" type="number" min="1" max="100" step="1" data-k="width"></label>
                <label class="editor-prop-row"><span class="editor-prop-label">Height (%)</span>
                    <input class="editor-prop-input" type="number" min="1" max="100" step="1" data-k="height"></label>
            </div>
            <label class="editor-prop-row"><span class="editor-prop-label">Layer<span class="editor-prop-label-note">higher is in front</span></span>
                <input class="editor-prop-input" type="number" min="1" max="999" step="1" data-k="zIndex"></label>

        </div>`;
    const inputs = Object.fromEntries(Array.from(card.querySelectorAll('input[data-k]')).map(i => [i.dataset.k, i]));
    const show = () => {
        inputs.x.value = pct(item.x, 0);          inputs.y.value = pct(item.y, 0);
        inputs.width.value = pct(item.width, 0.4); inputs.height.value = pct(item.height, 0.3);
        inputs.zIndex.value = item.zIndex ?? 10;
        // Light up a preset while the box is already in that position.
        const near = (a, b) => Math.abs((a ?? 0) - b) < 0.005;
        const w = item.width ?? 0.4, h = item.height ?? 0.3;
        const full = near(item.x, 0) && near(item.y, 0) && near(w, 1) && near(h, 1);
        const centred = !full && near(item.x, (1 - w) / 2) && near(item.y, (1 - h) / 2);
        card.querySelector('[data-preset="full"]').classList.toggle('is-active', full);
        card.querySelector('[data-preset="center"]').classList.toggle('is-active', centred);
    };
    show();
    card.addEventListener('input', (e) => {
        const k = e.target.dataset?.k;
        if (!k) return;
        const n = parseFloat(e.target.value);
        if (isNaN(n)) return;
        if (k === 'zIndex') item.zIndex = Math.round(n);
        else item[k] = Math.max(0, Math.min(100, n)) / 100;
        const active = document.activeElement;
        show();                                   // refresh the preset states…
        if (active?.isConnected) active.focus();  // …without stealing the field
        onLayout();
    });
    card.addEventListener('click', (e) => {
        const p = e.target.closest?.('[data-preset]')?.dataset.preset;
        if (!p) return;
        if (p === 'full') Object.assign(item, { x: 0, y: 0, width: 1, height: 1 });
        else {
            item.x = Math.max(0, (1 - (item.width ?? 0.4)) / 2);
            item.y = Math.max(0, (1 - (item.height ?? 0.3)) / 2);
        }
        show(); onLayout();
    });
    return card;
}

// Keep Tab inside the dialog while it's open.
function trapTab(e, root) {
    const focusables = Array.from(root.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
