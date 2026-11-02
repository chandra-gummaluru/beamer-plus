// A widget's properties, in the editor's right panel.
//
// Selecting a widget on the slide (or adding one) opens the panel with what
// every widget has: Name (in the panel header), Text size and its layout
// (full slide, box, reveal step), and Remove. Where it sits and how big it
// is can also be changed on the slide itself (drag it, drag its corner).
// The widget's own settings are not here: the widget edits them itself, in
// its edit mode (the Edit button in its top bar, while presenting).
//
// Every change is applied to the config item as it's made; the widget is
// rebuilt with them when edit mode closes.
import { widgetDisplay, setWidgetDisplay, TEXT_SIZES } from './widget-schema.js';

const near = (a, b) => Math.abs((a ?? 0) - b) < 0.005;
const isFullBox = (it) => near(it.x, 0) && near(it.y, 0) && near(it.width ?? 1, 1) && near(it.height ?? 1, 1);

/**
 * Fill `host` with General (Text size) and Layout (full slide, box, reveal
 * step). Remove is the panel's footer (properties.js).
 * @param {HTMLElement} host
 * @param {object} item     the widget's config item (edited in place)
 * @param {object} schema   from getWidgetSchema(item)
 * @param {object} opts
 * @param {() => void} opts.onLayout  after its box, display or step changed
 * @returns {{ refresh(): void }}  refresh: the box moved on the slide
 */
export function renderWidgetPanel(host, item, schema, { onLayout } = {}) {
    host.textContent = '';
    const root = document.createElement('div');
    root.className = 'wf wf--panel';
    const general = buildTextSizeGroup(item, schema);
    if (general) root.appendChild(general);
    const layout = buildLayoutCard(item, schema, () => onLayout?.());
    root.appendChild(layout.node);
    host.appendChild(root);
    return { refresh: layout.show };
}

/**
 * General: the widget's Text size, as a row of A's growing in size — the
 * default for the stepper in its top bar. Null for a widget without one
 * ("fontSize": false). onChange runs after each pick.
 */
export function buildTextSizeGroup(item, schema, onChange) {
    if (schema && schema.textSize === false) return null;
    const node = document.createElement('section');
    node.className = 'wf-group';
    node.innerHTML = `
        <div class="wf-group-title">General</div>
        <div class="wf-group-body">
            <div class="editor-prop-row editor-prop-row--seg">
                <div class="editor-prop-label">Text Size</div>
                <div class="wf-sizes" role="group" aria-label="Text Size"></div>
            </div>
        </div>`;
    const wrap = node.querySelector('.wf-sizes');
    const def = schema?.scale || '1.4';
    // The saved value, or the nearest step to it (an older deck's 1.8).
    const current = () => {
        const v = parseFloat(item.scale ?? def);
        if (isNaN(v)) return def;
        return TEXT_SIZES.reduce((best, s) => Math.abs(parseFloat(s) - v) < Math.abs(parseFloat(best) - v) ? s : best);
    };
    TEXT_SIZES.forEach((v, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wf-size-btn';
        b.dataset.v = v;
        const label = `${Math.round(parseFloat(v) * 100)}%`;
        b.title = label;
        b.setAttribute('aria-label', label);
        // 11px → 21px across the steps: the size you pick, drawn.
        const px = Math.round(11 + (10 * i) / Math.max(1, TEXT_SIZES.length - 1));
        b.innerHTML = `<span style="font-size:${px}px">A</span>`;
        b.addEventListener('click', () => {
            if (v === def) delete item.scale; else item.scale = v;
            mark();
            onChange?.();
        });
        wrap.appendChild(b);
    });
    function mark() {
        const cur = current();
        wrap.querySelectorAll('button').forEach(b => {
            const on = b.dataset.v === cur;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }
    mark();
    return node;
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
                <span>Fill the Whole Slide</span>
                <input type="checkbox" class="editor-switch" role="switch" data-k="full">
            </label>` : ''}
            <div class="wp-geom">
                <label class="editor-prop-row"><span class="editor-prop-label">X</span>
                    <span class="wp-num"><input class="field" type="number" min="0" max="100" step="1" data-k="x"><i>%</i></span></label>
                <label class="editor-prop-row"><span class="editor-prop-label">Y</span>
                    <span class="wp-num"><input class="field" type="number" min="0" max="100" step="1" data-k="y"><i>%</i></span></label>
                <label class="editor-prop-row"><span class="editor-prop-label">Width</span>
                    <span class="wp-num"><input class="field" type="number" min="5" max="100" step="1" data-k="width"><i>%</i></span></label>
                <label class="editor-prop-row"><span class="editor-prop-label">Height</span>
                    <span class="wp-num"><input class="field" type="number" min="5" max="100" step="1" data-k="height"><i>%</i></span></label>
            </div>`}
            <label class="editor-prop-row editor-prop-row--inline"><span class="editor-prop-label">Appear on Step</span>
                <input class="field" type="number" min="1" max="99" step="1" placeholder="Always" data-k="step"></label>
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
