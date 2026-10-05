// Widget settings, in the editor's right panel.
//
// Selecting a widget on the slide (or Edit in the slide's item list, or
// adding one) shows its settings here, in place of the slide's properties —
// the same way a video or a reveal box shows its own. Where the widget sits
// and how big it is are edited on the slide itself (drag it, drag its
// corner) or typed in here. The panel holds the widget's own settings (form
// from widget-fields.js, read from its `widget-schema` block) in sections:
// General (Name, Text size), Layout (a Full slide switch, X / Y / Width /
// Height, its reveal step), and the widget's own settings always last.
// Every change is applied to the config item live. (Removing a widget is
// the slide's item list, or Delete on the slide.)
//
// The cards stack: the widget's settings, then Layout. A long text field
// that declares "expand": true gets an Expand button that opens it in a
// roomy editor (widget-fields.js).
import { buildWidgetForm } from './widget-fields.js';
import { widgetDisplay, setWidgetDisplay } from './widget-schema.js';

const near = (a, b) => Math.abs((a ?? 0) - b) < 0.005;
const isFullBox = (it) => near(it.x, 0) && near(it.y, 0) && near(it.width ?? 1, 1) && near(it.height ?? 1, 1);

/**
 * Fill `host` with a widget's settings.
 * @param {HTMLElement} host
 * @param {object} item     the widget's config item (edited in place)
 * @param {object} schema   from getWidgetSchema(item)
 * @param {object} opts
 * @param {() => void} opts.onLayout  after its box, display or step changed
 * @param {() => void} opts.onName    after its Name changed
 * @returns {{ refresh(): void }}  refresh: the box moved on the slide
 */
export function renderWidgetPanel(host, item, schema, { onLayout, onName } = {}) {
    host.textContent = '';
    const form = buildWidgetForm(schema, item, 'panel');
    const layout = buildLayoutCard(item, schema, () => onLayout?.());
    // General (Name, Text size, Appear on step), then Layout, then the
    // widget's own settings.
    if (form.commonNode) {
        form.commonNode.after(layout.node);
        form.commonNode.querySelector('.wf-group-body').appendChild(layout.stepRow);
    } else form.node.insertBefore(layout.node, form.node.firstChild);
    // A full-slide-only widget has no layout to set.
    if (!layout.node.querySelector('.wf-group-body').children.length) layout.node.remove();
    host.appendChild(form.node);

    const apply = (e) => {
        if (layout.node.contains(e.target)) return;   // the Layout card applies itself
        form.apply(item);
        form.syncVisibility();
        onName?.();
    };
    form.node.addEventListener('input', apply);
    form.node.addEventListener('change', apply);
    return { refresh: layout.show };
}

// Layout: a Full slide switch over X / Y / Width / Height. Switching Full
// slide on fills in the numbers (the whole slide); editing a number — or
// dragging the box on the slide — switches it off. For a widget with an
// Overlay mode, off *is* overlay: no bar, a box over part of the slide.
function buildLayoutCard(item, schema, onLayout) {
    const node = document.createElement('section');
    node.className = 'wf-group wp-layout';
    const modal  = !!schema.modesDeclared;            // Full / Overlay
    const modes  = schema.modes || ['full'];
    const pinned = !!schema.fullSlide || (modal && !modes.includes('overlay'));
    const canFull = !modal || modes.includes('full');
    node.innerHTML = `
        <div class="wf-group-title">Layout</div>
        <div class="wf-group-body">
            ${pinned ? '' : `
            ${canFull ? `
            <label class="editor-prop-checkbox-row">
                <span>Full slide</span>
                <input type="checkbox" class="editor-switch" role="switch" data-k="full">
            </label>` : ''}
            <div class="wp-geom">
                <label class="editor-prop-row"><span class="editor-prop-label">X</span>
                    <span class="wp-num"><input class="editor-prop-input" type="number" min="0" max="100" step="1" data-k="x"><i>%</i></span></label>
                <label class="editor-prop-row"><span class="editor-prop-label">Y</span>
                    <span class="wp-num"><input class="editor-prop-input" type="number" min="0" max="100" step="1" data-k="y"><i>%</i></span></label>
                <label class="editor-prop-row"><span class="editor-prop-label">Width</span>
                    <span class="wp-num"><input class="editor-prop-input" type="number" min="5" max="100" step="1" data-k="width"><i>%</i></span></label>
                <label class="editor-prop-row"><span class="editor-prop-label">Height</span>
                    <span class="wp-num"><input class="editor-prop-input" type="number" min="5" max="100" step="1" data-k="height"><i>%</i></span></label>
            </div>`}
            <label class="editor-prop-row editor-prop-row--inline"><span class="editor-prop-label">Appear on step</span>
                <input class="editor-prop-input" type="number" min="1" max="99" step="1" placeholder="—" data-k="step"></label>
        </div>`;

    // Settle on a display now, so the saved deck says what it is and an old
    // deck's box is brought in line (full pins it to the slide).
    if (pinned) {
        if (!isFullBox(item)) { Object.assign(item, { x: 0, y: 0, width: 1, height: 1 }); onLayout(); }
        if (modal && item.display !== 'full') { item.display = 'full'; onLayout(); }
    } else if (modal) {
        const initial = widgetDisplay(item, schema);
        if (item.display !== initial || initial === 'full') { setWidgetDisplay(item, schema, initial); onLayout(); }
    }

    const fullSw = node.querySelector('input[data-k="full"]');
    const nums = Object.fromEntries(['x', 'y', 'width', 'height']
        .map(k => [k, node.querySelector(`input[data-k="${k}"]`)]).filter(([, el]) => el));
    const isFull = () => modal ? widgetDisplay(item, schema) === 'full' : isFullBox(item);

    function show() {
        if (fullSw) fullSw.checked = isFull();
        const active = document.activeElement;
        for (const [k, el] of Object.entries(nums)) {
            if (el !== active) el.value = String(Math.round((item[k] ?? (k === 'width' || k === 'height' ? 1 : 0)) * 100));
        }
    }

    fullSw?.addEventListener('change', () => {
        if (modal) setWidgetDisplay(item, schema, fullSw.checked ? 'full' : 'overlay');
        else if (fullSw.checked) Object.assign(item, { x: 0, y: 0, width: 1, height: 1 });
        else {
            // Off, from a full box: a smaller one in the middle to start from.
            Object.assign(item, { x: 0.2, y: 0.2, width: 0.6, height: 0.6 });
        }
        show(); onLayout();
    });

    for (const [k, el] of Object.entries(nums)) {
        el.addEventListener('input', () => {
            const n = parseFloat(el.value);
            if (isNaN(n)) return;
            // A number typed means a box of its own — Full slide goes off.
            if (modal && widgetDisplay(item, schema) === 'full') item.display = 'overlay';
            const v = Math.max(0, Math.min(100, n)) / 100;
            item[k] = (k === 'width' || k === 'height') ? Math.max(0.05, v) : v;
            show(); onLayout();
        });
    }

    // "Appear on step N" — hidden while presenting until that reveal step
    // (slides/reveals.js). Blank means always shown.
    const step = node.querySelector('input[data-k="step"]');
    const stepRow = step.closest('.editor-prop-row');
    const n = parseInt(item.step, 10);
    step.value = n > 0 ? String(n) : '';
    step.addEventListener('input', () => {
        const v = parseInt(step.value, 10);
        if (v > 0) item.step = v; else delete item.step;
        onLayout();
    });

    show();
    return { node, show, stepRow };
}
