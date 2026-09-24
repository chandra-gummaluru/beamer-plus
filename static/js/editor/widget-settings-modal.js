// Widget settings dialog — the roomy alternative to the properties sidebar.
//
// Opened from the expand button in the panel header. It builds the same form
// as the sidebar (widget-fields.js) over the same config item, laid out as
// cards across a wide dialog, and applies every change live — so closing it
// just hands back to a sidebar that is rebuilt to match.
import { buildWidgetForm } from './widget-fields.js';

let _open = null;   // { overlay, onKey, restoreFocus, onClose }

export function isWidgetSettingsOpen() { return !!_open; }

/**
 * @param {object} item     the widget's config item (edited in place)
 * @param {object} schema   from getWidgetSchema(item)
 * @param {object} opts
 * @param {string} opts.title       e.g. "Audience Response"
 * @param {() => void} opts.onChange  after each applied edit
 * @param {() => void} opts.onClose   after the dialog is gone
 */
export function openWidgetSettings(item, schema, { title, onChange, onClose } = {}) {
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
                <button type="button" class="btn wsm-done">Done</button>
            </header>
            <div class="wsm-body"></div>
        </div>`;
    overlay.querySelector('.wsm-title').textContent = title || schema.label || 'Widget';

    const form = buildWidgetForm(schema, item, 'modal');
    const body = overlay.querySelector('.wsm-body');
    body.appendChild(form.node);

    const apply = () => { form.apply(item); form.syncVisibility(); onChange?.(); };
    body.addEventListener('input', apply);
    body.addEventListener('change', apply);

    overlay.querySelector('.wsm-done').addEventListener('click', closeWidgetSettings);
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

export function closeWidgetSettings() {
    if (!_open) return;
    const { overlay, onKey, restoreFocus, onClose } = _open;
    _open = null;
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
    document.body.classList.remove('wsm-open');
    try { restoreFocus?.focus?.(); } catch (_) {}
    onClose?.();
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
