// Text-box annotation tool.
//
// Click anywhere on the slide with the text tool active and a small,
// borderless textbox opens right there. Font is fixed (one simple sans),
// size is one of three dots (small/regular/large) in the flyout sidebar.
// Segments wrapped in $...$ are rendered as LaTeX (via a vendored,
// offline copy of MathJax's SVG output) and baked onto the annotation
// canvas bitmap alongside the plain text when the box is committed.
import { bus } from '../core/events.js';

const FONT_FAMILY = 'Arial, Helvetica, sans-serif';
const SIZE_PX = { small: 16, regular: 22, large: 32 };
const TEXT_COLOR = '#242424';
const MATHJAX_SRC = '/static/vendor/mathjax/tex-svg.js';

// The editor textarea (.text-annotation-editor, in annotations.css) has a
// 1px border and "2px 4px" padding, which insets its actual text content box
// from its wrapper's top-left corner — where text-align:center really does
// its centering, not the wrapper's own edge. Every place that converts
// between "wrapper anchor" (used for placing/dragging the DOM box) and
// "content-box origin" (used for measuring/drawing/storing the rendered
// text) needs this same offset, or the committed ink lands to the left of
// where it visually sat while editing. Keep in sync with the CSS.
const EDITOR_INSET = { x: 9, y: 5 };   // border(1) + padding-left(8) / padding-top(4)
// Must match .text-annotation-editor's line-height in annotations.css — the
// canvas has to stack its lines on exactly the same rhythm the textarea used.
const LINE_HEIGHT_RATIO = 1.35;

/* ─── MathJax (lazy-loaded, offline, SVG output) ──────────────────────── */
// SVG output is used (rather than KaTeX's HTML+webfont output) specifically
// because it's self-contained vector paths — no font metrics/loading race to
// worry about when we serialize the <svg> and rasterize it onto the canvas.
let _mjReadyPromise = null;
function ensureMathJax() {
    if (window.MathJax?.tex2svg) return Promise.resolve(window.MathJax);
    if (_mjReadyPromise) return _mjReadyPromise;

    window.MathJax = {
        tex: { inlineMath: [['$', '$']] },
        svg: { fontCache: 'local' },   // each <svg> carries its own glyph defs
        startup: { typeset: false },
    };
    _mjReadyPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = MATHJAX_SRC;
        script.onload = () => {
            const p = window.MathJax?.startup?.promise;
            if (p) p.then(() => resolve(window.MathJax)).catch(reject);
            else resolve(window.MathJax);
        };
        script.onerror = () => reject(new Error('Failed to load MathJax'));
        document.head.appendChild(script);
    });
    return _mjReadyPromise;
}

// Render a single TeX expression to a ready-to-draw <img>, sized in real
// px (not MathJax's ambient `ex` units) and with the baseline offset needed
// to line it up with surrounding canvas text.
async function texToImage(tex, fontSizePx) {
    let MathJax;
    try {
        MathJax = await ensureMathJax();
    } catch {
        return null;
    }

    let container;
    try {
        container = MathJax.tex2svg(tex, { display: false });
    } catch {
        return null;
    }
    const svg = container?.querySelector?.('svg');
    if (!svg) return null;

    const viewBox = (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
    if (viewBox.length !== 4 || viewBox.some(Number.isNaN)) return null;
    const [, minY, vbW, vbH] = viewBox;
    if (!vbW || !vbH) return null;

    // MathJax's SVG viewBox is 1000 units per em, baseline at y=0.
    const scale = fontSizePx / 1000;
    const width = Math.max(1, vbW * scale);
    const height = Math.max(1, vbH * scale);
    const baselineFromTop = Math.max(0, -minY * scale);

    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.removeAttribute('style');

    const xml = new XMLSerializer().serializeToString(svg);
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);

    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ img, width, height, baselineFromTop });
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}

/* ─── per-slide box bookkeeping (for "reclick to edit") ───────────────── */
// The rendered pixels for a committed box live only in the canvas bitmap (same
// as every other annotation tool), but we keep lightweight metadata — where it
// is, how big, and its raw text — so a later tap in that spot can reopen it
// instead of stamping a new box on top. This is in-memory only (not part of
// the saved ZIP), so it survives navigation within a session but a box is no
// longer separately editable after a fresh reload — it's just baked-in ink at
// that point, like anything else drawn on the canvas.
function boxesForSlide(state, slideIdx) {
    if (!state.textBoxes) state.textBoxes = {};
    if (!state.textBoxes[slideIdx]) state.textBoxes[slideIdx] = [];
    return state.textBoxes[slideIdx];
}

function slideIndexForCvs(cvs, state) {
    return cvs === state.annCvs2 ? state.rightSlideIndex : state.currentSlide;
}

// A box's `rect` is the footprint of its painted ink (what to hit-test and
// what to erase); its `x`/`y` is the text origin (where to re-anchor the
// editor). They're deliberately separate — rendered math can spill outside
// the editor box that produced it.
function eraseRect(box) {
    return box.rect || { x: box.x, y: box.y, w: box.w || 1, h: box.h || 1 };
}

function findBoxAt(state, slideIdx, pos) {
    const boxes = boxesForSlide(state, slideIdx);
    // Search newest-first so overlapping boxes resolve to the most recent one.
    for (let i = boxes.length - 1; i >= 0; i--) {
        const r = eraseRect(boxes[i]);
        if (pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h) return boxes[i];
    }
    return null;
}

/* ─── parsing: $math$ + a little markdown ────────────────────────────── */
// Each line is split into segments. $...$ is math (rendered by MathJax);
// everything else is text carrying inline markdown styles:
//   **bold** / __bold__   *italic* / _italic_   `code`   ~~strike~~
// plus per-line markers:
//   "- item" / "* item" / "+ item"  → a bullet  •
//   "# Heading" / "## Heading"      → a larger, bold line
//   "> quote"                       → an italic, muted line with a bar
// A backslash escapes a marker (\* \_ \` \$ \~ \#). Markers that never close
// are left as typed. The raw text is kept, so reopening a box shows the
// markdown again for editing.

const ESC_RE = /\\([*_`$~#>\\-])/g;
// Escaped markers are swapped for private-use characters while parsing and
// restored at the end, so nothing treats them as syntax.
const ESC_MAP = { '*': '', '_': '', '`': '', '$': '', '~': '', '#': '', '>': '', '\\': '', '-': '' };
const UNESC = Object.fromEntries(Object.entries(ESC_MAP).map(([k, v]) => [v, k]));
const unescape = (s) => s.replace(/[-]/g, c => UNESC[c]);

function parseLine(rawLine) {
    let line = rawLine.replace(ESC_RE, (_, c) => ESC_MAP[c]);
    let kind = 'text';
    let scale = 1;
    let prefix = '';

    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
        kind = 'heading';
        scale = [1.5, 1.3, 1.15][m[1].length - 1];
        line = m[2];
    } else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) {
        prefix = m[1] + '•  ';
        line = m[2];
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
        kind = 'quote';
        line = m[1];
    }

    const base = { bold: kind === 'heading', italic: kind === 'quote', code: false, strike: false };
    const segments = [];
    if (prefix) segments.push({ type: 'text', value: prefix, ...base, bold: false, italic: false });

    // Math first: its contents are TeX, never markdown.
    const re = /\$([^$\n]+?)\$/g;
    let last = 0;
    while ((m = re.exec(line))) {
        if (m.index > last) parseInline(line.slice(last, m.index), base, segments);
        segments.push({ type: 'math', value: unescape(m[1]).trim() });
        last = re.lastIndex;
    }
    if (last < line.length) parseInline(line.slice(last), base, segments);
    if (segments.length === 0) segments.push({ type: 'text', value: '', ...base });
    for (const s of segments) if (s.type === 'text') s.value = unescape(s.value);
    return { kind, scale, segments };
}

// Inline markers, earliest match wins; ties go to the longer marker.
const INLINE = [
    { re: /`([^`]+)`/,                                     style: 'code' },
    { re: /\*\*(?=\S)(.+?)\*\*/,                           style: 'bold' },
    { re: /(?<![A-Za-z0-9])__(?=\S)(.+?)__(?![A-Za-z0-9])/, style: 'bold' },
    { re: /~~(?=\S)(.+?)~~/,                               style: 'strike' },
    { re: /\*(?=\S)([^*]+?)\*/,                            style: 'italic' },
    { re: /(?<![A-Za-z0-9])_(?=\S)([^_]+?)_(?![A-Za-z0-9])/, style: 'italic' },
];

function parseInline(text, style, out) {
    while (text) {
        let best = null;
        for (const rule of INLINE) {
            const m = rule.re.exec(text);
            if (m && (!best || m.index < best.m.index)) best = { m, rule };
        }
        if (!best) { out.push({ type: 'text', value: text, ...style }); return; }
        const { m, rule } = best;
        if (m.index > 0) out.push({ type: 'text', value: text.slice(0, m.index), ...style });
        if (rule.style === 'code') out.push({ type: 'text', value: m[1], ...style, code: true });
        else parseInline(m[1], { ...style, [rule.style]: true }, out);
        text = text.slice(m.index + m[0].length);
    }
}

// A box with list or quote lines is laid out flush-left (centred bullets
// look ragged); anything else stays centred. The live textarea follows the
// same rule so the text doesn't jump sideways on commit.
const BLOCK_LINE_RE = /^(\s*[-*+]\s+|>)/m;
function isFlushLeft(text) { return BLOCK_LINE_RE.test(text || ''); }

const CODE_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const CODE_BG = 'rgba(36, 36, 36, 0.07)';
const QUOTE_COLOR = '#5b5f66';

function fontFor(seg, sizePx) {
    if (seg.code) return `${Math.round(sizePx * 0.9)}px ${CODE_FONT}`;
    return `${seg.italic ? 'italic ' : ''}${seg.bold ? 'bold ' : ''}${sizePx}px ${FONT_FAMILY}`;
}
const CODE_PAD = 4;   // px either side of a code span's background

/* ─── matching the textarea's line box exactly ───────────────────────── */
// A CSS line box puts the baseline at half-leading + ascent from its top:
// the font's content area (ascent+descent) is centered inside line-height,
// and the glyphs sit on the baseline within it. Reproducing that formula —
// with the real font metrics the browser itself reports, rather than a
// hand-tuned fudge factor — is what makes the committed ink land on the same
// pixel row the text occupied while it was being typed.
function firstBaselineOffset(ctx, fontSizePx, lineHeight) {
    let ascent = fontSizePx * 0.905;    // Arial fallbacks, used only if the
    let descent = fontSizePx * 0.212;   // browser doesn't report the metrics
    try {
        const m = ctx.measureText('Hxg');
        if (m.fontBoundingBoxAscent != null && m.fontBoundingBoxDescent != null) {
            ascent = m.fontBoundingBoxAscent;
            descent = m.fontBoundingBoxDescent;
        }
    } catch { /* keep the fallbacks */ }
    return { ascent, descent, baseline: (lineHeight - (ascent + descent)) / 2 + ascent };
}

/* ─── rasterize the finished box onto the annotation canvas ──────────── */
// If `oldBox` is given (editing an existing box), its old footprint is erased
// first. Returns the drawn ink's bounding {x, y, w, h} so the caller can
// update the hit-test/erase metadata, or null if nothing was drawn (empty
// text). Note this rect is *not* the same as the (x, y) origin passed in:
// rendered math can be wider than the editor box was, so the ink can extend
// past the box on either side.
async function commitTextAnnotation(cvs, x, y, rawText, size, oldBox, boxWidth) {
    const ctx = cvs.ctx;
    const text = rawText.replace(/\r\n/g, '\n');

    if (oldBox) {
        const r = eraseRect(oldBox);
        ctx.clearRect(r.x, r.y, r.w, r.h);
    }
    if (!text.trim()) {
        if (oldBox) cvs.commitHistory();   // editing down to empty = delete
        return null;
    }

    const baseSize = SIZE_PX[size] || SIZE_PX.regular;
    const lines = text.split('\n').map(parseLine);
    for (const ln of lines) {
        ln.sizePx = Math.round(baseSize * ln.scale);
        ln.lineHeight = ln.sizePx * LINE_HEIGHT_RATIO;
    }

    // Pre-render every math segment before touching the canvas — drawImage
    // needs the images decoded, and we don't want a half-drawn box on screen.
    for (const ln of lines) {
        for (const seg of ln.segments) {
            if (seg.type === 'math' && seg.value) {
                seg.rendered = await texToImage(seg.value, ln.sizePx);
            }
        }
    }

    ctx.save();
    ctx.textBaseline = 'alphabetic';

    // Width of one segment as it will be drawn.
    const segWidth = (seg, sizePx) => {
        if (seg.type === 'math') {
            if (seg.rendered) return seg.rendered.width + 2;
            ctx.font = fontFor({}, sizePx);
            return seg.value ? ctx.measureText(`$${seg.value}$`).width : 0;
        }
        if (!seg.value) return 0;
        ctx.font = fontFor(seg, sizePx);
        return ctx.measureText(seg.value).width + (seg.code ? CODE_PAD * 2 : 0);
    };

    // Measure each line before drawing anything, so every line can be
    // centered under the widest one instead of all left-aligned to `x`.
    const lineWidths = lines.map(ln => ln.segments.reduce((w, s) => w + segWidth(s, ln.sizePx), 0));
    // Center within the *editor box's* own width — the exact box the user
    // watched their text sit centered inside — rather than a width re-derived
    // from the rendered content (formatted text is narrower than the
    // markdown that produced it, and a math image differs from its "$…$").
    const layoutWidth = Math.max(1, boxWidth || 0, ...(boxWidth ? [] : lineWidths));
    const flushLeft = isFlushLeft(text);

    // Track what was actually painted so the erase/hit rect covers the ink
    // even where it overflows the editor box (wide math, descenders).
    let minX = x, maxX = x + layoutWidth;
    let minY = y, maxY = y;
    const mark = (x0, x1, y0, y1) => {
        if (x0 < minX) minX = x0;
        if (x1 > maxX) maxX = x1;
        if (y0 < minY) minY = y0;
        if (y1 > maxY) maxY = y1;
    };

    let lineTop = y;
    lines.forEach((ln, i) => {
        ctx.font = fontFor({}, ln.sizePx);
        const metrics = firstBaselineOffset(ctx, ln.sizePx, ln.lineHeight);
        const baselineY = lineTop + metrics.baseline;
        // Flush-left quotes are indented to leave room for their bar.
        const startX = flushLeft ? x + (ln.kind === 'quote' ? 12 : 0) : x + (layoutWidth - lineWidths[i]) / 2;
        let cursorX = startX;

        for (const seg of ln.segments) {
            if (seg.type === 'math' && seg.rendered) {
                const { img, width, height, baselineFromTop } = seg.rendered;
                const top = baselineY - baselineFromTop;
                ctx.drawImage(img, cursorX, top, width, height);
                mark(cursorX, cursorX + width, top, top + height);
                cursorX += width + 2;
                continue;
            }
            // Plain/styled text, or a math segment MathJax couldn't render —
            // in that case fall back to the raw markup rather than dropping it.
            const value = seg.type === 'math' ? `$${seg.value}$` : seg.value;
            if (!value) continue;
            const w = segWidth(seg, ln.sizePx);
            ctx.font = fontFor(seg.type === 'math' ? {} : seg, ln.sizePx);
            if (seg.code) {
                const h = ln.sizePx * 1.15;
                const top = baselineY - ln.sizePx * 0.85;
                ctx.fillStyle = CODE_BG;
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(cursorX, top, w, h, 4);
                else ctx.rect(cursorX, top, w, h);
                ctx.fill();
            }
            ctx.fillStyle = ln.kind === 'quote' ? QUOTE_COLOR : TEXT_COLOR;
            const tx = cursorX + (seg.code ? CODE_PAD : 0);
            ctx.fillText(value, tx, baselineY);
            if (seg.strike) {
                const sy = baselineY - ln.sizePx * 0.3;
                ctx.fillRect(tx, sy, w - (seg.code ? CODE_PAD * 2 : 0), Math.max(1, ln.sizePx / 14));
            }
            mark(cursorX, cursorX + w, baselineY - metrics.ascent, baselineY + metrics.descent);
            cursorX += w;
        }

        // Quote: a short bar to the left of the line.
        if (ln.kind === 'quote' && cursorX > startX) {
            ctx.fillStyle = 'rgba(36, 36, 36, 0.25)';
            ctx.fillRect(startX - 10, lineTop + ln.lineHeight * 0.15, 3, ln.lineHeight * 0.7);
            mark(startX - 10, startX, lineTop, lineTop + ln.lineHeight);
        }
        lineTop += ln.lineHeight;
        mark(x, x, lineTop, lineTop);
    });
    ctx.restore();
    cvs.commitHistory();

    const pad = 2;
    return {
        x: Math.max(0, minX - pad),
        y: Math.max(0, minY - pad),
        w: Math.max(1, maxX - minX + pad * 2),
        h: Math.max(1, maxY - minY + pad * 2),
    };
}

/* ─── the floating DOM editor ──────────────────────────────────────────── */
const MOVE_ICON = `<svg viewBox="0 0 16 10" fill="currentColor" aria-hidden="true"><circle cx="3" cy="2.5" r="1.3"/><circle cx="8" cy="2.5" r="1.3"/><circle cx="13" cy="2.5" r="1.3"/><circle cx="3" cy="7.5" r="1.3"/><circle cx="8" cy="7.5" r="1.3"/><circle cx="13" cy="7.5" r="1.3"/></svg>`;

function autoGrow(box) {
    const probe = document.createElement('span');
    probe.style.cssText = 'visibility:hidden;position:fixed;left:-9999px;white-space:pre;';
    probe.style.font = `${box.style.fontSize} ${FONT_FAMILY}`;
    document.body.appendChild(probe);

    // Measure every line, not just the one with the most characters — narrow
    // characters can make a longer string physically shorter, and any line
    // wider than the box would soft-wrap, which the committed render (which
    // never wraps) wouldn't reproduce.
    let widest = 0;
    for (const line of (box.value || box.placeholder || '').split('\n')) {
        probe.textContent = line;
        if (probe.offsetWidth > widest) widest = probe.offsetWidth;
    }
    probe.remove();
    box.style.width = `${Math.max(120, widest + 24)}px`;

    // Height after width — scrollHeight depends on the width just set.
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight}px`;
}

function clampPos(cvs, x, y) {
    const rect = cvs.canvas.getBoundingClientRect();
    return {
        x: Math.max(0, Math.min(x, Math.max(0, rect.width - 130))),
        y: Math.max(0, Math.min(y, Math.max(0, rect.height - 32))),
    };
}

// The wrapper is positioned with `position: fixed` (viewport coordinates), not
// `position: absolute` relative to whatever DOM ancestor it happens to sit
// under. That ancestor's own box (padding, centering, containing-block rules)
// is otherwise easy to get subtly wrong — and that's exactly what caused the
// editor to show up in the wrong spot (see the #text-size-sidebar fix
// earlier). `pos` is always canvas-relative CSS px; this just projects it to
// screen space fresh, every time, off the canvas's actual current rect.
function applyWrapperPos(cvs, wrapper, pos) {
    const rect = cvs.canvas.getBoundingClientRect();
    wrapper.style.left = `${rect.left + pos.x}px`;
    wrapper.style.top = `${rect.top + pos.y}px`;
}

function openTextEditor(cvs, state, pos) {
    // Starting a new box while one is already open commits the old one first
    // (rather than discarding it) — clicking around to drop several text
    // boxes shouldn't lose whatever was already typed.
    closeActiveEditor(state, true);

    const container = document.body;

    // Tapping inside an existing box's footprint reopens it for editing
    // (pre-filled) instead of stamping a new box on top of it.
    const slideIdx = slideIndexForCvs(cvs, state);
    const editingBox = findBoxAt(state, slideIdx, pos);

    const size = editingBox ? editingBox.size : (state.textSize || 'regular');
    // editingBox.x/y (like pos) is a content-box origin — where the rendered
    // ink actually starts — so back it out to the wrapper anchor the DOM box
    // is placed at; applyWrapperPos() re-adds the same inset implicitly via
    // the textarea's own border/padding when it's rendered.
    const targetX = editingBox ? editingBox.x - EDITOR_INSET.x : pos.x;
    const targetY = editingBox ? editingBox.y - EDITOR_INSET.y : pos.y;
    const start = clampPos(cvs, targetX, targetY);

    // Editing an existing box: lift its current pixels out immediately so the
    // live textarea (which shows the text being retyped) isn't rendered on
    // top of a still-visible copy underneath it — that's what made it look
    // like the text had doubled. Keep the snapshot so Escape can put it back
    // exactly as it was, since nothing is committed to canvas history here.
    let restoreSnapshot = null;
    if (editingBox) {
        const ctx = cvs.ctx;
        const r = eraseRect(editingBox);
        // getImageData works in device pixels; the context is scaled by dpr,
        // so convert before reading (and put it back the same way on cancel).
        const dpr = cvs.dpr || 1;
        const dx = Math.floor(r.x * dpr), dy = Math.floor(r.y * dpr);
        const dw = Math.max(1, Math.ceil(r.w * dpr) + 1), dh = Math.max(1, Math.ceil(r.h * dpr) + 1);
        restoreSnapshot = ctx.getImageData(dx, dy, dw, dh);
        restoreSnapshot._at = { x: dx, y: dy };
        ctx.clearRect(r.x, r.y, r.w, r.h);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'text-annotation-wrapper';

    const handle = document.createElement('div');
    handle.className = 'text-annotation-drag-handle';
    handle.title = 'Drag to move';
    handle.innerHTML = MOVE_ICON;

    const box = document.createElement('textarea');
    box.className = 'text-annotation-editor';
    box.rows = 1;
    box.spellcheck = false;
    box.placeholder = 'Type here…';
    box.style.fontSize = `${SIZE_PX[size] || SIZE_PX.regular}px`;
    if (editingBox) box.value = editingBox.text;

    wrapper.appendChild(handle);
    wrapper.appendChild(box);
    container.appendChild(wrapper);

    // entry.pos is the single source of truth for where the box lives, always
    // in canvas-relative CSS px — the wrapper's actual on-screen (fixed)
    // position is just a projection of it, recomputed on open and on every
    // drag move rather than read back out of computed style.
    const entry = { wrapper, box, cvs, size, editingBox, slideIdx, restoreSnapshot, pos: { ...start } };
    state._textEditor = entry;

    applyWrapperPos(cvs, wrapper, entry.pos);
    autoGrow(box);
    box.focus();
    if (editingBox) {
        const len = box.value.length;
        box.setSelectionRange(len, len);   // cursor at end, ready to append/fix
    }

    const syncAlign = () => { box.style.textAlign = isFlushLeft(box.value) ? 'left' : 'center'; };
    syncAlign();
    box.addEventListener('input', () => { syncAlign(); autoGrow(box); });

    box.addEventListener('keydown', (e) => {
        // Keep typing (including letters that double as tool shortcuts) from
        // leaking to the document-level keyboard-shortcut handler.
        e.stopPropagation();
        if (e.key === 'Escape') {
            e.preventDefault();
            closeActiveEditor(state, false, true);
        }
    });

    box.addEventListener('blur', (e) => {
        // Picking a size dot also blurs the textarea — that's an in-tool
        // interaction, not "leaving" the box, so don't close it. The sidebar
        // click handler refocuses the box right after.
        const next = e.relatedTarget;
        if (next && next.closest && next.closest('#text-size-sidebar')) return;
        // Only fires here if the pointerdown-capture listener below didn't
        // already handle this (e.g. Tab-key or programmatic focus changes,
        // rather than a click).
        if (state._textEditor === entry) closeActiveEditor(state, true, true);
    });

    // Drag handle — repositions the whole wrapper while editing. Everything
    // is computed in canvas-relative space (matching entry.pos, the source of
    // truth), then projected to screen coordinates via applyWrapperPos — a
    // drag just before committing/cancelling behaves exactly like any other
    // placement.
    let dragOffset = null;
    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const canvasRect = cvs.canvas.getBoundingClientRect();
        const clickX = e.clientX - canvasRect.left;
        const clickY = e.clientY - canvasRect.top;
        dragOffset = { x: clickX - entry.pos.x, y: clickY - entry.pos.y };
    });
    handle.addEventListener('pointermove', (e) => {
        if (!dragOffset) return;
        const canvasRect = cvs.canvas.getBoundingClientRect();
        const clickX = e.clientX - canvasRect.left;
        const clickY = e.clientY - canvasRect.top;
        entry.pos = clampPos(cvs, clickX - dragOffset.x, clickY - dragOffset.y);
        applyWrapperPos(cvs, wrapper, entry.pos);
    });
    const endDrag = (e) => {
        if (!dragOffset) return;
        dragOffset = null;
        handle.releasePointerCapture(e.pointerId);
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

    bus.emit('textbox:opened');
}

// Returns a promise that resolves once the annotation (if any) has actually
// been rasterized and committed to the canvas's history — callers that read
// a snapshot right after (goToSlide, split-view toggle, …) need to wait for
// this, since LaTeX segments render asynchronously (MathJax load + typeset).
//
// `revert`, when true, switches back to whichever tool/pen was active before
// Text was selected — Text is a one-shot "place a box, you're done" tool, so
// finishing one (by committing or cancelling) hands control back automatically.
// Internal callers that are about to open another editor right away (e.g.
// re-clicking to place the next box while the previous one is still open)
// pass revert=false so that in-progress hand-off isn't interrupted.
function closeActiveEditor(state, commit, revert = false) {
    const entry = state._textEditor;
    if (!entry) return Promise.resolve();
    state._textEditor = null;

    const { wrapper, box, cvs, size, editingBox, slideIdx, restoreSnapshot, pos } = entry;
    const text = box.value;
    // pos is the wrapper's anchor; shift by the same border+padding inset the
    // textarea itself has, so the canvas draws starting from where the text
    // content actually visually began, not the wrapper's outer edge.
    const x = pos.x + EDITOR_INSET.x;
    const y = pos.y + EDITOR_INSET.y;
    // The textarea's own (content-box) width is what the user actually saw
    // centered text sit inside while editing — autoGrow() picked it based on
    // raw typed characters (including "$…$" markup), which rarely matches
    // what commitTextAnnotation would measure from the *rendered* content
    // (a math image is a different width than its source). Passing this
    // through makes the canvas center within the same box the user watched,
    // instead of independently re-deriving a (slightly different) width and
    // visibly shifting the text sideways on commit.
    const boxWidth = parseFloat(box.style.width) || 0;
    wrapper.remove();
    bus.emit('textbox:closed');

    // Cancelling an edit (Escape): put the original pixels we lifted out back
    // exactly as they were — nothing was committed to canvas history in the
    // meantime, so there's nothing else to undo.
    if (!commit) {
        if (editingBox && restoreSnapshot) {
            const at = restoreSnapshot._at || { x: editingBox.x, y: editingBox.y };
            cvs.ctx.putImageData(restoreSnapshot, at.x, at.y);
        }
        if (revert) restorePreviousSelection();
        return Promise.resolve();
    }

    return commitTextAnnotation(cvs, x, y, text, size, editingBox, boxWidth).then((rect) => {
        const boxes = boxesForSlide(state, slideIdx);
        if (editingBox) {
            const i = boxes.indexOf(editingBox);
            if (i !== -1) boxes.splice(i, 1);
        }
        if (rect) {
            boxes.push({ x, y, rect, size, text });
        }
        bus.emit('textbox:committed');
        if (revert) restorePreviousSelection();
    });
}

/* ─── remember the tool/pen active before Text was selected ──────────── */
// Text is a "place one box and you're done" tool (like Spotlight — see
// slides/spotlight.js for the same pattern): once you click away from it,
// switch back automatically instead of leaving Text selected. Pens don't fire
// 'tool:change' (only 'pen:select'), so both are tracked to restore whichever
// was really active, not just a generic fallback.
let _prevSelection = { kind: 'tool', value: 'hand' };

bus.on('tool:change', (tool) => {
    if (tool !== 'text') _prevSelection = { kind: 'tool', value: tool };
});
bus.on('pen:select', (pen) => {
    _prevSelection = { kind: 'pen', value: pen.slot };
});

// Re-clicks the actual button/pen-slot so its own click handler runs exactly
// as if the user had picked it themselves (selection highlight, canvas mode,
// sidebar visibility, etc. all stay in sync automatically).
function restorePreviousSelection() {
    if (_prevSelection.kind === 'pen') {
        document.querySelectorAll('#pen-slots .pen-slot-btn')[_prevSelection.value]?.click();
    } else {
        document.querySelector(`#tool-container .tool-btn[data-tool="${_prevSelection.value}"]`)?.click();
    }
}

/* ─── public API ────────────────────────────────────────────────────── */
// Wires the small size sidebar (small/regular/large dots). Call once at
// startup, same as the other annotation feature modules.
export function initTextAnnotations(state) {
    state.textSize = state.textSize || 'regular';

    const sidebar = document.getElementById('text-size-sidebar');
    if (sidebar) {
        const buttons = sidebar.querySelectorAll('.btn[data-size]');
        buttons.forEach(btn => {
            btn.classList.toggle('btn_selected', btn.dataset.size === state.textSize);
            btn.addEventListener('click', () => {
                buttons.forEach(b => b.classList.toggle('btn_selected', b === btn));
                state.textSize = btn.dataset.size;
                bus.emit('textsize:select', state.textSize);
            });
        });
    }

    // Live-resize the box that's currently being edited (if any) and hand
    // focus straight back to it so typing can continue uninterrupted.
    bus.on('textsize:select', (size) => {
        const entry = state._textEditor;
        if (!entry) return;
        entry.size = size;
        entry.box.style.fontSize = `${SIZE_PX[size] || SIZE_PX.regular}px`;
        autoGrow(entry.box);
        entry.box.focus();
    });

    // Belt-and-suspenders: commit an open box the moment the user interacts
    // with anything else (a toolbar button, the slide navigator, etc.), not
    // just when the textarea itself blurs. Capture phase so it runs before
    // whatever was clicked handles its own click.
    document.addEventListener('pointerdown', (e) => {
        const entry = state._textEditor;
        if (!entry) return;
        if (entry.wrapper.contains(e.target)) return;   // the box itself, or its drag handle
        if (e.target.closest && e.target.closest('#text-size-sidebar')) return;
        // Text is a one-shot tool: any click away from the box — the canvas,
        // a toolbar button, anywhere — commits it and hands control back to
        // whatever tool/pen was active before Text was selected.
        closeActiveEditor(state, true, true);
    }, true);

    // Reopening an existing box without reselecting the Text tool.
    //
    //  • Hand tool  — a single tap on a box opens it (there's nothing else a
    //    tap on ink would mean in Hand mode).
    //  • Any drawing tool (pen, highlighter, eraser, shape) — a *double* click
    //    opens it, since single clicks there legitimately draw.
    //
    // The mode is read off the canvas itself (cvs.pointer_mode), not
    // state.annotationTool: picking a pen slot emits 'pen:select' and changes
    // the canvas mode to 'draw'/'highlight' without touching annotationTool,
    // which therefore still reads 'hand' while a pen is active.
    //
    // The annotation canvas has pointer-events:none in Hand mode (so clicks
    // pass through to widgets/video underneath), so this can't just be a
    // canvas listener — it checks every pointerdown against the known box
    // positions itself, in the capture phase, before anything under it reacts.
    const DBL_MS = 450, DBL_SLOP = 14;
    let lastTap = { t: 0, x: 0, y: 0, historyLen: 0 };

    document.addEventListener('pointerdown', (e) => {
        if (state._textEditor || !e.isPrimary) return;

        const panes = [
            { cvs: state.annCvs,  pdf: document.getElementById('pdf-canvas') },
            { cvs: state.annCvs2, pdf: document.getElementById('pdf-canvas-2') },
        ];
        for (const { cvs, pdf } of panes) {
            if (!cvs || !pdf) continue;
            const rect = pdf.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;
            if (e.clientX < rect.left || e.clientX > rect.right ||
                e.clientY < rect.top  || e.clientY > rect.bottom) continue;

            // The Text tool reopens boxes on a single click already, via
            // openTextEditor's own hit test — leave it alone.
            if (cvs.pointer_mode === 'text') return;

            const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            const slideIdx = slideIndexForCvs(cvs, state);
            const hit = findBoxAt(state, slideIdx, pos);
            if (!hit) break;

            const drawing = cvs.pointer_mode !== 'hand';
            // Spotlight / laser / select also run in 'hand' pointer mode but
            // have their own meaning for a click — don't hijack it.
            if (!drawing && state.annotationTool !== 'hand') return;

            const now = Date.now();
            const isSecondClick =
                now - lastTap.t < DBL_MS &&
                Math.abs(e.clientX - lastTap.x) < DBL_SLOP &&
                Math.abs(e.clientY - lastTap.y) < DBL_SLOP;

            if (drawing && !isSecondClick) {
                // First click of a possible double — let it draw as usual, but
                // remember where the undo stack was so the second click can
                // take that stray mark back off.
                lastTap = { t: now, x: e.clientX, y: e.clientY, historyLen: cvs.history?.length ?? 0 };
                return;
            }

            // Keep whatever's underneath (a widget, a video, the canvas's own
            // draw handler) from also reacting to this same click.
            e.preventDefault();
            e.stopPropagation();

            // If the first click of the double left a dot (pen) or took a bite
            // out of the text (eraser), roll it back — the user meant "edit
            // this", not "draw on it".
            const strayMark = drawing && (cvs.history?.length ?? 0) === lastTap.historyLen + 1;
            lastTap = { t: 0, x: 0, y: 0, historyLen: 0 };

            // Switch into the Text tool so all the usual editing machinery —
            // size sidebar, widget click-through, revert-to-previous-tool on
            // close — applies exactly as if the user had selected Text.
            document.querySelector('#tool-container .tool-btn[data-tool="text"]')?.click();

            // undo() repaints from a snapshot asynchronously; the editor has to
            // wait for it, since opening lifts the box's pixels off the canvas.
            if (strayMark) cvs.undo().then(() => openTextEditor(cvs, state, pos));
            else openTextEditor(cvs, state, pos);
            return;
        }
        lastTap = { t: 0, x: 0, y: 0, historyLen: 0 };
    }, true);
}

// Wires a single annotation Canvas instance (left or right pane) so a click
// while the text tool is active places an editor at that point. Call for
// state.annCvs at startup and again for state.annCvs2 once split view
// creates it.
export function wireTextCanvas(cvs, state) {
    if (!cvs || cvs._textWired) return;
    cvs._textWired = true;
    cvs.onTextPlace = (pos) => openTextEditor(cvs, state, pos);
}

// If a box is open when the user switches away from the text tool via a
// route that doesn't naturally blur it (e.g. a keyboard shortcut), commit it.
// Returns a promise — await it before reading/saving a canvas snapshot.
export function commitOpenTextEditor(state) {
    return closeActiveEditor(state, true);
}

// Forget the reclick-to-edit metadata for one slide — call wherever the
// annotation bitmap itself gets wiped (Clear All, eraser hold-to-clear) so a
// later tap doesn't "find" a box that no longer has any pixels.
export function clearTextBoxes(state, slideIdx) {
    if (state.textBoxes) state.textBoxes[slideIdx] = [];
}

// Forget every slide's metadata — call when a new/different presentation loads.
export function resetAllTextBoxes(state) {
    state.textBoxes = {};
}
