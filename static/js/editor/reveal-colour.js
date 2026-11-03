// Reveal box colour — the "Solid Color" look of a reveal box (slides/reveals.js)
// and the eyedropper that picks it off the slide.
//
// Where the browser has the EyeDropper API (Chrome, Edge) the picker is the
// system one: any pixel on screen, slide image, widgets, media and all. The
// editor's hatched boxes are hidden while it is open so they can't tint what
// is picked. Elsewhere (Firefox, Safari) a crosshair goes over the slide and
// a click reads the slide image under it; Escape cancels.
import { getSlideEl } from './context.js';
import { colourAt, toHex } from '../slides/reveals.js';

/** Show a Solid Color box's colour under its hatching in edit mode. */
export function paintRevealOverlay(div, item) {
    if (!div) return;
    const on = item?.style === 'color' && !!item.color;
    div.classList.toggle('edit-overlay--reveal-color', on);
    if (on) div.style.setProperty('--reveal-fill', item.color);
    else div.style.removeProperty('--reveal-fill');
}

let _busy = false;

/** Let the presenter pick a colour on the slide. Resolves to "#rrggbb", or null if cancelled. */
export async function pickColourFromSlide(button) {
    if (_busy) return null;
    _busy = true;
    button?.classList.add('is-active');
    document.body.classList.add('reveal-picking');
    try {
        if ('EyeDropper' in window) {
            try {
                const { sRGBHex } = await new window.EyeDropper().open();
                return toHex(sRGBHex);
            } catch { return null; }   // Escape / clicked away
        }
        return await pickOnSlide();
    } finally {
        document.body.classList.remove('reveal-picking');
        button?.classList.remove('is-active');
        _busy = false;
    }
}

// Fallback: a crosshair over the slide, with a swatch following the pointer.
function pickOnSlide() {
    const container = getSlideEl();
    if (!container) return Promise.resolve(null);
    return new Promise((resolve) => {
        const surface = document.createElement('div');
        surface.className = 'reveal-pick-surface';
        const chip = document.createElement('div');
        chip.className = 'reveal-pick-chip';
        chip.hidden = true;
        surface.appendChild(chip);
        container.appendChild(surface);

        const done = (hex) => {
            surface.remove();
            window.removeEventListener('keydown', onKey, true);
            resolve(hex);
        };
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault(); e.stopPropagation();
            done(null);
        };
        surface.addEventListener('pointermove', (e) => {
            const hex = colourAt(container, e.clientX, e.clientY);
            const r = container.getBoundingClientRect();
            chip.hidden = false;
            chip.style.left = `${e.clientX - r.left}px`;
            chip.style.top = `${e.clientY - r.top}px`;
            chip.style.setProperty('--c', hex);
            chip.textContent = hex;
        });
        surface.addEventListener('pointerleave', () => { chip.hidden = true; });
        surface.addEventListener('pointerdown', (e) => {
            // Keep the editor from treating this as a click on empty slide.
            e.preventDefault(); e.stopPropagation();
            done(colourAt(container, e.clientX, e.clientY));
        });
        window.addEventListener('keydown', onKey, true);
    });
}
