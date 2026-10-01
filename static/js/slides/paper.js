// Paper for blank slides — lined, grid or dotted backgrounds.
//
// Stored on the blank slide's structure entry (so it travels in
// slide-order.json with the rest of the deck):
//
//   { type: 'blank', blankId, paper: { style: 'grid', spacing: 'm',
//                                      thickness: 'm', color: 'grey' } }
//
// Drawn with CSS gradients sized in percent of the slide, so the pattern
// scales with the slide instead of needing a redraw on resize. Slides are
// 4:3, so a square cell is S% of the width by S/0.75 % of the height.

export const PAPER_STYLES = [
    { v: 'none',  l: 'Plain' },
    { v: 'lined', l: 'Lined' },
    { v: 'grid',  l: 'Grid' },
    { v: 'dots',  l: 'Dots' },
];
export const PAPER_SPACING = [
    { v: 's', l: 'Tight',  pct: 3 },
    { v: 'm', l: 'Medium', pct: 4.5 },
    { v: 'l', l: 'Wide',   pct: 7 },
];
export const PAPER_THICKNESS = [
    { v: 's', l: 'Thin',   line: 1,   dot: 1.4 },
    { v: 'm', l: 'Medium', line: 1.5, dot: 2.2 },
    { v: 'l', l: 'Bold',   line: 2.5, dot: 3.2 },
];
export const PAPER_COLORS = [
    { v: 'grey', l: 'Grey', c: 'rgba(26, 26, 24, 0.14)' },
    { v: 'blue', l: 'Blue', c: 'rgba(47, 93, 209, 0.26)' },
    { v: 'dark', l: 'Dark', c: 'rgba(26, 26, 24, 0.32)' },
];

const pick = (list, v, fallback) => list.find(o => o.v === v) || list.find(o => o.v === fallback);

export function normalizePaper(p) {
    const style = pick(PAPER_STYLES, p?.style, 'none').v;
    return {
        style,
        spacing:   pick(PAPER_SPACING, p?.spacing, 'm').v,
        thickness: pick(PAPER_THICKNESS, p?.thickness, 'm').v,
        color:     pick(PAPER_COLORS, p?.color, 'grey').v,
    };
}

/**
 * CSS background for `paper`, or null for plain. `thumb` draws hairline
 * strokes, for the navigator's small previews.
 */
export function paperCss(paper, { thumb = false } = {}) {
    if (!paper || !paper.style || paper.style === 'none') return null;
    const p  = normalizePaper(paper);
    const sx = pick(PAPER_SPACING, p.spacing, 'm').pct;
    const sy = sx / 0.75;
    const th = pick(PAPER_THICKNESS, p.thickness, 'm');
    const c  = pick(PAPER_COLORS, p.color, 'grey').c;
    const t  = thumb ? 1 : th.line;
    const size = `${sx}% ${sy}%`;
    if (p.style === 'lined') {
        return {
            backgroundImage: `linear-gradient(to bottom, ${c} ${t}px, transparent ${t}px)`,
            backgroundSize: `100% ${sy}%`,
            backgroundPosition: '0 0',
        };
    }
    if (p.style === 'grid') {
        return {
            backgroundImage: `linear-gradient(to right, ${c} ${t}px, transparent ${t}px), ` +
                             `linear-gradient(to bottom, ${c} ${t}px, transparent ${t}px)`,
            backgroundSize: `${size}, ${size}`,
            backgroundPosition: '0 0, 0 0',
        };
    }
    // dots
    const r = thumb ? 0.8 : th.dot;
    return {
        backgroundImage: `radial-gradient(circle at center, ${c} ${r}px, transparent ${r + 0.7}px)`,
        backgroundSize: size,
        backgroundPosition: '0 0',
    };
}

/** Put `paper` on an element's background (or clear it). */
export function applyPaper(el, paper, opts) {
    if (!el) return;
    const css = paperCss(paper, opts);
    el.style.backgroundImage    = css ? css.backgroundImage : '';
    el.style.backgroundSize     = css ? css.backgroundSize : '';
    el.style.backgroundPosition = css ? css.backgroundPosition : '';
    el.style.backgroundRepeat   = css ? 'repeat' : '';
}
