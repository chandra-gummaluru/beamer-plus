// The paper chooser — used by the editor panel (a blank slide's paper) and
// by the Add Page window, so both look and work the same.
//
//   Background   four little pages: Plain, Lined, Grid, Dots
//   Spacing      a slider with three stops: Tight, Medium, Wide
//   Line Weight  the same, Thin, Medium, Bold ("Dot Size" for dots)
//   Colour       three coloured dots
//
// Plain has nothing else to set, so the other three hide for it.
//
//   const picker = createPaperPicker({ get, set, onStyleDblClick });
//   container.append(picker.styles, picker.options);
//   picker.sync();          // after the value changes from outside
//
// get() returns the paper being edited ({ style, spacing, thickness, color });
// set(key, value) changes one part of it; the picker then redraws itself and
// calls onChange(), if given.

import { PAPER_STYLES, PAPER_SPACING, PAPER_THICKNESS, PAPER_COLORS, applyPaper, normalizePaper } from './paper.js';

const titleCase = s => String(s).replace(/\b\w/g, c => c.toUpperCase());
// What each colour's dot shows: the paper's ink is faint on purpose, so the
// dots use a solid version of it that still reads as grey / blue / dark.
const DOT = { grey: '#bdbdb8', blue: '#6d8ee0', dark: '#55554f' };

let _seq = 0;

export function createPaperPicker({ get, set, onChange, onStyleDblClick } = {}) {
    const id = `paper-picker-${++_seq}`;

    /* Background: little pages, each the style close up. */
    const styles = document.createElement('div');
    styles.className = 'paper-row';
    styles.innerHTML = `<span class="paper-label" id="${id}-bg">Background</span>
        <div class="paper-tiles" role="radiogroup" aria-labelledby="${id}-bg">
            ${PAPER_STYLES.map(o => `<button type="button" class="paper-tile" role="radio" data-v="${o.v}">
                <span class="paper-tile-page"></span><span class="paper-tile-name">${titleCase(o.l)}</span></button>`).join('')}
        </div>`;
    styles.querySelectorAll('.paper-tile').forEach(t => {
        t.addEventListener('click', () => choose('style', t.dataset.v));
        if (onStyleDblClick) t.addEventListener('dblclick', () => { choose('style', t.dataset.v); onStyleDblClick(); });
    });

    /* The rest: two sliders and the colour dots. */
    const options = document.createElement('div');
    options.className = 'paper-options';
    options.append(
        slider('spacing', 'Spacing', PAPER_SPACING),
        slider('thickness', 'Line Weight', PAPER_THICKNESS),
        dots(),
    );

    function choose(key, v) {
        if (get()[key] === v) return;
        set(key, v);
        sync();
        onChange?.();
    }

    // A slider with a stop per choice, like the split view's divider: drag
    // the handle, click the track or a name, or use the arrow keys.
    function slider(key, label, list) {
        const row = document.createElement('div');
        row.className = 'paper-row';
        row.dataset.key = key;
        const last = list.length - 1;
        row.innerHTML = `<span class="paper-label" id="${id}-${key}">${label}</span>
            <div class="paper-slider">
                <div class="paper-slider-rail" role="slider" tabindex="0" aria-labelledby="${id}-${key}"
                     aria-valuemin="0" aria-valuemax="${last}">
                    <span class="paper-slider-line"></span>
                    ${list.map((_, i) => `<span class="paper-slider-tick" style="left:${(i / last) * 100}%"></span>`).join('')}
                    <span class="paper-slider-handle"></span>
                </div>
                <div class="paper-slider-names">
                    ${list.map((o, i) => `<button type="button" tabindex="-1" data-i="${i}">${titleCase(o.l)}</button>`).join('')}
                </div>
            </div>`;
        const rail = row.querySelector('.paper-slider-rail');
        const at = (i) => choose(key, list[Math.max(0, Math.min(last, i))].v);
        const index = () => Math.max(0, list.findIndex(o => o.v === get()[key]));
        const fromX = (x) => {
            const r = rail.getBoundingClientRect();
            return Math.round(((x - r.left) / r.width) * last);
        };
        let dragging = false;
        rail.addEventListener('pointerdown', (e) => {
            dragging = true;
            rail.setPointerCapture(e.pointerId);
            rail.classList.add('is-dragging');
            at(fromX(e.clientX));
        });
        rail.addEventListener('pointermove', (e) => { if (dragging) at(fromX(e.clientX)); });
        const end = () => { dragging = false; rail.classList.remove('is-dragging'); };
        rail.addEventListener('pointerup', end);
        rail.addEventListener('pointercancel', end);
        rail.addEventListener('keydown', (e) => {
            const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
            if (step) at(index() + step);
            else if (e.key === 'Home') at(0);
            else if (e.key === 'End') at(last);
            else return;
            e.preventDefault();
            e.stopPropagation();   // not the slide shortcuts
        });
        row.querySelectorAll('.paper-slider-names button').forEach(b =>
            b.addEventListener('click', () => at(Number(b.dataset.i))));
        row.sync = (p) => {
            const i = Math.max(0, list.findIndex(o => o.v === p[key]));
            rail.style.setProperty('--pos', `${(i / last) * 100}%`);
            rail.setAttribute('aria-valuenow', String(i));
            rail.setAttribute('aria-valuetext', titleCase(list[i].l));
            row.querySelectorAll('.paper-slider-names button').forEach(b =>
                b.classList.toggle('is-selected', Number(b.dataset.i) === i));
        };
        return row;
    }

    function dots() {
        const row = document.createElement('div');
        row.className = 'paper-row paper-row--inline';   // the dots to the right of the label
        row.innerHTML = `<span class="paper-label" id="${id}-color">Colour</span>
            <div class="paper-dots" role="radiogroup" aria-labelledby="${id}-color">
                ${PAPER_COLORS.map(o => `<button type="button" class="paper-dot" role="radio" data-v="${o.v}"
                    title="${titleCase(o.l)}" aria-label="${titleCase(o.l)}" style="--c:${DOT[o.v] || o.c}"></button>`).join('')}
            </div>`;
        row.querySelectorAll('.paper-dot').forEach(b => b.addEventListener('click', () => choose('color', b.dataset.v)));
        row.sync = (p) => row.querySelectorAll('.paper-dot').forEach(b => {
            const on = b.dataset.v === p.color;
            b.classList.toggle('is-selected', on);
            b.setAttribute('aria-checked', String(on));
        });
        return row;
    }

    function sync() {
        const p = normalizePaper(get());
        styles.querySelectorAll('.paper-tile').forEach(t => {
            const on = t.dataset.v === p.style;
            t.classList.toggle('is-selected', on);
            t.setAttribute('aria-checked', String(on));
            applyPaper(t.querySelector('.paper-tile-page'), { ...p, style: t.dataset.v }, { card: true });
        });
        options.hidden = p.style === 'none';
        options.querySelector('[data-key="thickness"] .paper-label').textContent = p.style === 'dots' ? 'Dot Size' : 'Line Weight';
        for (const row of options.children) row.sync?.(p);
    }

    return { styles, options, sync };
}
