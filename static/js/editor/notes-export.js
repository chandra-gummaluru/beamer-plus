// Notes export — the whole deck as one flat PDF, with everything that only
// lives in Beamer+ drawn in: pen annotations, each widget as it stands right
// now, videos / audio / 3D models as labelled stand-ins, and poll results.
//
// Built entirely in the browser with pdf-lib (loaded on first use):
//   · PDF slides are copied from slides.pdf as real vector pages — text stays
//     selectable and sharp — and the extras are drawn on top.
//   · Blank slides become new pages of the same size, with their paper.
//   · Widgets are printed from a throwaway copy of each (printWidget in the
//     renderer), set to the live widget's current state. A widget answers
//     with an image for its box and, optionally, extra pages that go right
//     after its slide. A widget that doesn't answer gets a placeholder box.
//   · Hidden slides are left out. A split-view slide prints its two panes,
//     each slide at most once in the whole PDF (see notesSlideOrder).
import { ctx } from './context.js';
import { bus } from '../core/events.js';
import { configKeyOf, getSlideLabels } from '../slides/structure.js';
import { requestWidgetStates, printWidget } from '../core/iframe-widget-renderer.js';
import { PAPER_SPACING, PAPER_THICKNESS, PAPER_COLORS, normalizePaper } from '../slides/paper.js';

const PDFLIB_SRC = '/static/vendor/pdf-lib.min.js';

// Beamer's default 4:3 page (128 mm × 96 mm), for a deck with no PDF page
// to take the size from.
const DEFAULT_PAGE = [362.83, 272.13];

// Audio players are a fixed 40px tall on stage, whatever the slide's size.
const AUDIO_PX = 40;

const INK    = [0.10, 0.10, 0.094];
const DIM    = [0.45, 0.45, 0.43];
const FAINT  = [0.66, 0.66, 0.64];
const RULE   = [0.84, 0.84, 0.82];
const WASH   = [0.965, 0.965, 0.955];
const CODEBG = [0.955, 0.955, 0.945];
const ERR    = [0.72, 0.16, 0.13];

let _pdfLibReady = null;
function loadPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (!_pdfLibReady) {
        _pdfLibReady = new Promise((ok, bad) => {
            const s = document.createElement('script');
            s.src = PDFLIB_SRC;
            s.onload  = () => window.PDFLib ? ok(window.PDFLib) : bad(new Error('pdf-lib failed to initialise'));
            s.onerror = () => { _pdfLibReady = null; bad(new Error('Could not load pdf-lib')); };
            document.head.appendChild(s);
        });
    }
    return _pdfLibReady;
}

/* ─── progress ─────────────────────────────────────────────────── */

function showProgress(message) {
    const modal = window.BeamerModal;
    const msgEl = modal?.open?.querySelector('.custom-modal-message');
    if (modal?.open?.classList.contains('modal-loading') && msgEl) { msgEl.textContent = message; return; }
    modal?.show({ kind: 'loading', title: 'Building notes…', message });
}

/* ─── text ─────────────────────────────────────────────────────── */
// The standard PDF fonts only cover WinAnsi (Latin-1 plus a few). Anything
// outside it would make pdf-lib throw, so map the usual suspects to ASCII
// and replace the rest.
const _WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const _TRANSLIT = {
    '−': '-', '‐': '-', '‑': '-', '→': '->', '←': '<-', '⇒': '=>', '↔': '<->',
    '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '∞': 'inf', '×': '×', '·': '·',
    '…': '…', ' ': ' ', ' ': ' ', ' ': ' ', '​': '',
    '✓': 'v', '✗': 'x', '✕': 'x', '•': '•', '▶': '>', '►': '>', '★': '*',
    'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'θ': 'theta',
    'λ': 'lambda', 'μ': 'mu', 'π': 'pi', 'σ': 'sigma', 'Σ': 'Sum', 'Δ': 'Delta',
};
function winAnsi(s) {
    let out = '';
    for (const ch of String(s ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ')) {
        const c = ch.codePointAt(0);
        if (ch === '\n' || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || _WINANSI_EXTRA.has(ch)) out += ch;
        else if (_TRANSLIT[ch] !== undefined) out += _TRANSLIT[ch];
        else if (c < 0x20) continue;
        else out += '?';
    }
    return out;
}

// Greedy word wrap; a word wider than the line is broken by characters.
function wrapLine(text, font, size, maxW) {
    if (!text) return [''];
    const lines = [];
    const words = text.split(/(\s+)/);
    let line = '';
    const width = (t) => font.widthOfTextAtSize(t, size);
    for (const word of words) {
        if (!word) continue;
        const trial = line + word;
        if (width(trial) <= maxW) { line = trial; continue; }
        if (line.trim()) { lines.push(line.replace(/\s+$/, '')); line = ''; }
        if (/^\s+$/.test(word)) continue;
        if (width(word) <= maxW) { line = word; continue; }
        let chunk = '';
        for (const ch of word) {
            if (width(chunk + ch) > maxW && chunk) { lines.push(chunk); chunk = ''; }
            chunk += ch;
        }
        line = chunk;
    }
    lines.push(line.replace(/\s+$/, ''));
    return lines;
}
function wrapText(text, font, size, maxW) {
    return winAnsi(text).split('\n').flatMap(l => wrapLine(l, font, size, maxW));
}

function fitText(text, font, size, maxW) {
    let t = winAnsi(text).replace(/\n/g, ' ');
    if (font.widthOfTextAtSize(t, size) <= maxW) return t;
    while (t.length > 1 && font.widthOfTextAtSize(t + '...', size) > maxW) t = t.slice(0, -1);
    return t + '...';
}

/* ─── images ───────────────────────────────────────────────────── */

function loadImage(src) {
    return new Promise((ok, bad) => {
        const img = new Image();
        img.onload = () => ok(img);
        img.onerror = () => bad(new Error('image failed to load'));
        img.src = src;
    });
}

// Embed any image the browser can decode. PNG and JPEG go in as they are;
// anything else (SVG, WebP, GIF) is rasterised to PNG first.
async function embedAny(pdf, src, rasterWidth = 1600) {
    if (typeof src !== 'string' || !src) return null;
    try {
        if (/^data:image\/png/i.test(src))               return await pdf.embedPng(src);
        if (/^data:image\/jpe?g/i.test(src))             return await pdf.embedJpg(src);
        const img = await loadImage(src);
        const w = img.naturalWidth || rasterWidth;
        const h = img.naturalHeight || Math.round(rasterWidth * 0.75);
        const k = Math.max(1, rasterWidth / w);
        const c = document.createElement('canvas');
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return await pdf.embedPng(c.toDataURL('image/png'));
    } catch (err) {
        console.warn('[notes] could not embed image', err);
        return null;
    }
}

// Contain-fit `iw × ih` inside a rect, centred.
function containRect(iw, ih, r) {
    const k = Math.min(r.w / iw, r.h / ih);
    const w = iw * k, h = ih * k;
    return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/* ─── media stand-ins ──────────────────────────────────────────── */

const _withTimeout = (p, ms, fallback = null) =>
    Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);

async function mediaUrl(path) {
    const s = ctx.state;
    if (s.mediaCache?.[path]) return s.mediaCache[path];
    const pending = s.editorNewFiles?.[path];
    if (pending) return URL.createObjectURL(new Blob([pending]));
    const f = s.zipFile?.file(path);
    if (!f) return null;
    return URL.createObjectURL(await f.async('blob'));
}

// A frame from 10% in (at most 2s) — the very first frame is often black.
async function videoFrame(url) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    const grab = new Promise((ok, bad) => {
        v.addEventListener('error', () => bad(new Error('video failed')), { once: true });
        v.addEventListener('loadedmetadata', () => {
            const t = Number.isFinite(v.duration) ? Math.min(2, v.duration * 0.1) : 0;
            v.addEventListener('seeked', () => ok(), { once: true });
            try { v.currentTime = t || 0.01; } catch (e) { bad(e); }
        }, { once: true });
    });
    try {
        if ((await _withTimeout(grab.then(() => true), 6000, false)) !== true || !v.videoWidth) return null;
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        return c.toDataURL('image/jpeg', 0.88);
    } catch (_) {
        return null;
    } finally {
        v.removeAttribute('src'); v.load();
    }
}

// Render the model once in a hidden <model-viewer> and keep the picture.
async function modelSnapshot(url, m, box) {
    if (!customElements.get('model-viewer')) return null;
    const mv = document.createElement('model-viewer');
    Object.assign(mv.style, {
        position: 'fixed', left: '0px', top: '0px', opacity: '0', pointerEvents: 'none', zIndex: '-1',
        width: `${Math.round(box.width)}px`, height: `${Math.round(box.height)}px`,
    });
    mv.setAttribute('shadow-intensity', '1');
    mv.setAttribute('interaction-prompt', 'none');
    if (m.animationName) mv.setAttribute('animation-name', m.animationName);
    mv.src = url;
    document.body.appendChild(mv);
    try {
        const ok = await _withTimeout(new Promise(r => {
            mv.addEventListener('load',  () => r(true),  { once: true });
            mv.addEventListener('error', () => r(false), { once: true });
        }), 10000, false);
        if (!ok) return null;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return mv.toDataURL?.('image/png') || null;
    } catch (_) {
        return null;
    } finally {
        mv.remove();
    }
}

// The name the deck was uploaded with, without its extension.
const deckBaseName = () => ctx.state.deckName || 'presentation';

const baseName = (p) => String(p || '').split('/').pop() || 'file';

/* ─── the exporter ─────────────────────────────────────────────── */

let _busy = false;

export async function downloadNotes() {
    const s = ctx.state;
    if (!s.zipFile) {
        window.BeamerModal?.show({ kind: 'error', title: 'Nothing to export', message: 'No presentation loaded.' });
        return;
    }
    if (_busy) return;
    _busy = true;
    showProgress('Preparing…');

    try {
        // Commit what's on the canvas so the latest strokes are in.
        bus.emit('annotations:flush');

        const PDFLib = await loadPdfLib();
        const { PDFDocument, StandardFonts, rgb } = PDFLib;
        const out = await PDFDocument.create();
        out.setTitle('Lecture notes');
        out.setCreator('Beamer+');
        out.setProducer('Beamer+ (pdf-lib)');

        const fonts = {
            sans:  await out.embedFont(StandardFonts.Helvetica),
            bold:  await out.embedFont(StandardFonts.HelveticaBold),
            mono:  await out.embedFont(StandardFonts.Courier),
        };

        const pdfFile = s.zipFile.file('slides.pdf');
        const src = pdfFile ? await PDFDocument.load(await pdfFile.async('uint8array'), { ignoreEncryption: true }) : null;
        const srcPages = src ? src.getPages() : [];
        const firstBox = srcPages[0]?.getCropBox?.();
        const blankSize = firstBox ? [firstBox.width, firstBox.height] : DEFAULT_PAGE;

        // Widgets are sized as they are on stage now, so they lay out the
        // way the presenter saw them.
        const stageRect = document.getElementById('pdf-canvas')?.getBoundingClientRect();
        const refW = stageRect?.width  > 50 ? stageRect.width  : 1024;
        const refH = stageRect?.height > 50 ? stageRect.height : refW * 0.75;

        const labels = getSlideLabels(s.slideStructure);
        const slides = notesSlideOrder(s.slideStructure, labels);

        // Every slide's config, and the current state of every widget on them.
        const configs = new Map();
        for (const sl of slides) configs.set(sl.i, await readConfig(configKeyOf(sl.obj)));
        const allIds = [];
        for (const cfg of configs.values()) for (const w of cfg?.widgets || []) if (w?.id != null) allIds.push(String(w.id));
        const states = allIds.length ? await requestWidgetStates(allIds, 2000) : {};

        // Copy every PDF page in one go: one copier for the lot shares fonts
        // and images between pages instead of duplicating them per page.
        const pdfSlides = slides.filter(sl => sl.obj.type === 'pdf' && src && sl.obj.pdfIndex < srcPages.length);
        const copied = pdfSlides.length ? await out.copyPages(src, pdfSlides.map(sl => sl.obj.pdfIndex)) : [];
        const copiedFor = new Map(pdfSlides.map((sl, k) => [sl.i, copied[k]]));

        let n = 0;
        for (const sl of slides) {
            n++;
            showProgress(`Slide ${sl.label} (${n} of ${slides.length})`);
            const cfg = configs.get(sl.i) || {};

            // ── The page itself ──────────────────────────────────────
            let page;
            if (copiedFor.has(sl.i)) {
                page = out.addPage(copiedFor.get(sl.i));
            } else {
                page = out.addPage(blankSize);
                page.drawRectangle({ x: 0, y: 0, width: blankSize[0], height: blankSize[1], color: rgb(1, 1, 1) });
                if (sl.obj.type === 'blank') drawPaper(page, sl.obj.paper, refW, rgb);
            }
            const box = page.getCropBox();
            const P = { x: box.x, y: box.y, w: box.width, h: box.height };
            // Slide fractions (top-left origin) → PDF points (bottom-left).
            const rectOf = (fx, fy, fw, fh) => ({
                x: P.x + fx * P.w,
                y: P.y + P.h - (fy + fh) * P.h,
                w: fw * P.w,
                h: fh * P.h,
            });

            // ── What sits on it, back to front ───────────────────────
            const items = [];
            (cfg.videos || []).forEach(v => items.push({ kind: 'video', z: v.zIndex ?? 5, d: v }));
            (cfg.audios || []).forEach(a => items.push({ kind: 'audio', z: a.zIndex ?? 5, d: a }));
            (cfg.models || []).forEach(m => items.push({ kind: 'model', z: m.zIndex ?? 5, d: m }));
            (cfg.widgets || []).forEach(w => items.push({ kind: 'widget', z: w.zIndex || 10, d: w }));
            items.sort((a, b) => a.z - b.z);

            const extraSections = [];
            let fillsSlide = null;   // a widget covering the whole slide, and what it printed
            for (const it of items) {
                const d = it.d;
                if (it.kind === 'video') {
                    const r = rectOf(d.x, d.y, d.width, d.height);
                    const url = await mediaUrl(d.path);
                    const frame = url ? await videoFrame(url) : null;
                    await drawMediaBox(out, page, r, frame, 'Video', baseName(d.path), fonts, rgb, true);
                } else if (it.kind === 'audio') {
                    const fx = d.x ?? 0.1, fy = d.y ?? 0.1, fw = d.width ?? 0.4;
                    const r = rectOf(fx, fy, fw, AUDIO_PX / refH);
                    drawAudioBar(page, r, baseName(d.path), fonts, rgb);
                } else if (it.kind === 'model') {
                    const r = rectOf(d.x, d.y, d.width, d.height);
                    const url = await mediaUrl(d.path);
                    const shot = url ? await modelSnapshot(url, d, { width: d.width * refW, height: d.height * refH }) : null;
                    await drawMediaBox(out, page, r, shot, '3D model', d.alt && d.alt !== '3D model' ? d.alt : baseName(d.path), fonts, rgb, false);
                } else {
                    const res = await printOne(d, states[String(d.id)], refW, refH);
                    const full = res.fullSlide;
                    const r = full ? rectOf(0, 0, 1, 1) : rectOf(d.x, d.y, d.width, d.height);
                    const img = res.ok && res.image ? await embedAny(out, res.image) : null;
                    if (img) {
                        const c = containRect(img.width, img.height, r);
                        page.drawImage(img, { x: c.x, y: c.y, width: c.w, height: c.h });
                    } else {
                        drawPlaceholder(page, r, res.label, res.ok ? 'Nothing to show' : 'Interactive widget', fonts, rgb);
                    }
                    for (const sec of res.pages || []) extraSections.push({ ...sec, from: res.label });
                    const covers = full || (d.x <= 0.005 && d.y <= 0.005 &&
                                            d.x + d.width >= 0.995 && d.y + d.height >= 0.995);
                    if (covers) fillsSlide = res;
                }
            }

            // ── Ink on top of everything, as on stage ────────────────
            const ann = s.annotations?.[sl.i];
            const inked = await hasInk(ann);

            // A widget that fills the slide and prints its own pages (the
            // notebook, the Python workspace) would otherwise appear twice:
            // once as a screenshot of the slide, then again, readably, on its
            // pages. Keep only the pages — unless the slide carries more than
            // the widget (other media, or ink drawn over it).
            const replaced = items.length === 1 && fillsSlide?.ok && fillsSlide.pages?.length > 0 && !inked;
            if (replaced) {
                out.removePage(out.getPageCount() - 1);
            } else if (inked) {
                const img = await embedAny(out, ann);
                if (img) page.drawImage(img, { x: P.x, y: P.y, width: P.w, height: P.h });
            }

            // ── A widget's extra pages, right after its slide ────────
            for (const sec of extraSections) {
                await flowSection(out, sec, sl.label, [P.w, P.h], fonts, rgb);
            }
        }

        if (!out.getPageCount()) throw new Error('The deck has no visible slides.');

        showProgress('Saving…');
        const bytes = await out.save();
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'), { href: url, download: `${deckBaseName()}-notes.pdf` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        window.BeamerModal?.close();
    } catch (err) {
        console.error('[notes] export failed', err);
        window.BeamerModal?.close();
        window.BeamerModal?.show({ kind: 'error', title: 'Notes export failed', message: err.message || String(err) });
    } finally {
        _busy = false;
    }
}

// Which slides go in the notes, in order. Visible PDF pages and blanks appear
// where they sit. A visible split-view slide stands for its two panes: each
// pane not already in the notes is printed there, in the view's place (so a
// pane that is hidden on its own, used only in the split, still makes it
// in). Every slide appears at most once — a pane printed at its view is not
// printed again at its own position.
export function notesSlideOrder(structure, labels = getSlideLabels(structure)) {
    const n = structure.length;
    const out = [];
    const done = new Set();
    const add = (i) => {
        const obj = structure[i];
        if (!obj || obj.type === 'view' || done.has(i)) return;
        done.add(i);
        out.push({ obj, i, label: labels[i] });
    };
    structure.forEach((obj, i) => {
        if (!obj || obj.hidden) return;
        if (obj.type !== 'view') { add(i); return; }
        for (const p of [obj.left, obj.right]) {
            if (Number.isInteger(p) && p >= 0 && p < n) add(p);
        }
    });
    return out;
}

// Whether an annotation snapshot has anything on it. The canvas is saved
// whenever its slide is left, so an untouched slide still has a (blank) PNG.
async function hasInk(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length <= 100) return false;
    try {
        const img = await loadImage(dataUrl);
        const W = 320, H = Math.max(1, Math.round(W * (img.naturalHeight / img.naturalWidth || 0.75)));
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0, W, H);
        const px = cx.getImageData(0, 0, W, H).data;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 8) return true;
        return false;
    } catch (_) { return true; }   // can't tell: keep it
}

// A slide's config as it stands: in memory if it has been loaded (and maybe
// edited) this session, else the file in the deck.
async function readConfig(key) {
    if (key == null) return null;
    const cfgs = ctx.state.slideConfigs || {};
    if (Object.prototype.hasOwnProperty.call(cfgs, key) && cfgs[key] !== undefined) return cfgs[key];
    try {
        const f = ctx.state.zipFile?.file(`config/s${key}.json`);
        return f ? JSON.parse(await f.async('string')) : null;
    } catch (_) { return null; }
}

async function printOne(w, state, refW, refH) {
    const host = document.getElementById('notes-print-host') || (() => {
        const el = document.createElement('div');
        el.id = 'notes-print-host';
        Object.assign(el.style, { position: 'fixed', left: '0', top: '0', width: '0', height: '0', overflow: 'visible', zIndex: '-1' });
        document.body.appendChild(el);
        return el;
    })();
    // Full-slide widgets are laid out over the whole slide whatever box an
    // older deck saved; printWidget tells us via the schema.
    const res = await printWidget(w, {
        zipFile: ctx.state.zipFile,
        box: { width: (w.width || 1) * refW, height: (w.height || 1) * refH },
        state,
        host,
        fullBox: { width: refW, height: refH },
    });
    return res;
}

/* ─── drawing ──────────────────────────────────────────────────── */

function drawPaper(page, paper, refW, rgb) {
    if (!paper || !paper.style || paper.style === 'none') return;
    const p  = normalizePaper(paper);
    const { width: W, height: H } = page.getSize();
    const sx = (PAPER_SPACING.find(o => o.v === p.spacing)?.pct ?? 4.5) / 100 * W;
    const sy = sx;                         // square cells: S% of the width both ways
    const th = PAPER_THICKNESS.find(o => o.v === p.thickness) || PAPER_THICKNESS[1];
    const m  = /rgba?\(([^)]+)\)/.exec(PAPER_COLORS.find(o => o.v === p.color)?.c || '');
    const [r, g, b, a] = m ? m[1].split(',').map(Number) : [26, 26, 24, 0.14];
    const color = rgb(r / 255, g / 255, b / 255);
    const opacity = a ?? 1;
    const px = W / refW;                   // one on-stage pixel, in points
    const t = th.line * px;
    if (p.style === 'lined' || p.style === 'grid') {
        for (let y = H; y > 0; y -= sy) page.drawLine({ start: { x: 0, y }, end: { x: W, y }, thickness: t, color, opacity });
    }
    if (p.style === 'grid') {
        for (let x = 0; x < W; x += sx) page.drawLine({ start: { x, y: 0 }, end: { x, y: H }, thickness: t, color, opacity });
    }
    if (p.style === 'dots') {
        const rad = th.dot * px;
        for (let y = H - sy / 2; y > 0; y -= sy) {
            for (let x = sx / 2; x < W; x += sx) page.drawCircle({ x, y, size: rad, color, opacity });
        }
    }
}

function labelSize(r, pageW) {
    return Math.max(pageW / 90, Math.min(pageW / 34, r.w / 16, r.h / 5));
}

function drawPlaceholder(page, r, title, sub, fonts, rgb) {
    const pageW = page.getWidth();
    page.drawRectangle({
        x: r.x, y: r.y, width: r.w, height: r.h,
        color: rgb(...WASH), borderColor: rgb(...FAINT),
        borderWidth: Math.max(0.4, pageW / 700), borderDashArray: [pageW / 160, pageW / 240],
    });
    const fs = labelSize(r, pageW);
    const t1 = fitText(title, fonts.bold, fs, r.w * 0.9);
    const t2 = fitText(sub, fonts.sans, fs * 0.72, r.w * 0.9);
    const w1 = fonts.bold.widthOfTextAtSize(t1, fs);
    const w2 = fonts.sans.widthOfTextAtSize(t2, fs * 0.72);
    const cy = r.y + r.h / 2;
    page.drawText(t1, { x: r.x + (r.w - w1) / 2, y: cy + fs * 0.15, size: fs, font: fonts.bold, color: rgb(...INK) });
    page.drawText(t2, { x: r.x + (r.w - w2) / 2, y: cy - fs * 0.95, size: fs * 0.72, font: fonts.sans, color: rgb(...DIM) });
}

// A video or 3D model: its picture if we have one, letterboxed in its box,
// with a small caption saying what it is. Videos get a play mark.
async function drawMediaBox(pdf, page, r, picture, kind, name, fonts, rgb, isVideo) {
    const pageW = page.getWidth();
    const img = picture ? await embedAny(pdf, picture) : null;
    if (!img) { drawPlaceholder(page, r, kind, name, fonts, rgb); return; }
    page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: isVideo ? rgb(0, 0, 0) : rgb(...WASH) });
    const c = containRect(img.width, img.height, r);
    page.drawImage(img, { x: c.x, y: c.y, width: c.w, height: c.h });
    if (isVideo) {
        const rad = Math.min(r.w, r.h) * 0.11;
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        page.drawCircle({ x: cx, y: cy, size: rad, color: rgb(0, 0, 0), opacity: 0.55 });
        const k = rad * 0.5;
        // drawSvgPath's y axis points down, from the given origin.
        page.drawSvgPath(`M ${-k * 0.7} ${-k} L ${k * 1.1} 0 L ${-k * 0.7} ${k} Z`, { x: cx, y: cy, color: rgb(1, 1, 1) });
    }
    const fs = Math.max(pageW / 110, Math.min(pageW / 60, r.h / 10));
    const cap = fitText(`${kind}: ${name}`, fonts.sans, fs, r.w - fs * 1.2);
    const cw = fonts.sans.widthOfTextAtSize(cap, fs);
    page.drawRectangle({ x: r.x, y: r.y, width: Math.min(r.w, cw + fs * 1.2), height: fs * 1.7, color: rgb(0, 0, 0), opacity: 0.6 });
    page.drawText(cap, { x: r.x + fs * 0.6, y: r.y + fs * 0.55, size: fs, font: fonts.sans, color: rgb(1, 1, 1) });
}

function drawAudioBar(page, r, name, fonts, rgb) {
    const h = r.h;
    page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: h, color: rgb(...WASH), borderColor: rgb(...RULE), borderWidth: h / 40 });
    // Speaker mark.
    const u = h / 10, x0 = r.x + h * 0.35, cy = r.y + h / 2;
    page.drawSvgPath(`M 0 ${-u} L ${u} ${-u} L ${u * 2.4} ${-u * 2.2} L ${u * 2.4} ${u * 2.2} L ${u} ${u} L 0 ${u} Z`,
                     { x: x0, y: cy, color: rgb(...DIM) });
    const fs = h * 0.36;
    const tx = x0 + u * 3.6;
    page.drawText(fitText(`Audio: ${name}`, fonts.sans, fs, r.x + r.w - tx - h * 0.3),
                  { x: tx, y: cy - fs * 0.35, size: fs, font: fonts.sans, color: rgb(...INK) });
}

/* ─── a widget's extra pages ───────────────────────────────────── */
// A section is { title, blocks: [ heading | text | image ] }. It starts on a
// new page the size of the slides and flows over as many as it needs; an
// image taller than a page is sliced. Sizes scale with the page, so a small
// Beamer page and a big one come out alike when viewed to fit.

// The column width an image block's CSS pixels are measured against: an
// image this wide fills the column, a narrower one keeps its proportion.
const COLUMN_PX = 760;

async function flowSection(pdf, sec, slideLabel, [W, H], fonts, rgb) {
    const M    = W * 0.07;
    const FS   = W / 54;
    const LH   = FS * 1.35;
    const colW = W - 2 * M;
    const top  = H - M;
    const bottom = M + FS * 1.6;     // room for the footer
    const pages = [];

    let page, y;
    const newPage = () => {
        page = pdf.addPage([W, H]);
        pages.push(page);
        y = top;
        // Running header: where this came from.
        const head = fitText(`Slide ${slideLabel}  ·  ${sec.from || 'Widget'}`, fonts.sans, FS * 0.75, colW);
        page.drawText(head, { x: M, y: y - FS * 0.75, size: FS * 0.75, font: fonts.sans, color: rgb(...DIM) });
        y -= FS * 1.4;
        page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: W / 900, color: rgb(...RULE) });
        y -= FS * 1.1;
    };
    const ensure = (h) => { if (y - h < bottom) newPage(); };

    newPage();
    if (sec.title) {
        for (const line of wrapText(sec.title, fonts.bold, FS * 1.5, colW)) {
            ensure(FS * 1.9);
            page.drawText(line, { x: M, y: y - FS * 1.5, size: FS * 1.5, font: fonts.bold, color: rgb(...INK) });
            y -= FS * 1.9;
        }
        y -= FS * 0.5;
    }

    for (const b of sec.blocks || []) {
        if (b.type === 'image') {
            const img = await embedAnyForFlow(pdf, b.src);
            if (!img) continue;
            const natW = b.width || img.width;
            const w = Math.min(colW, colW * natW / (sec.columnWidth || COLUMN_PX));
            const h = w * (img.height / img.width);
            const avail = top - bottom - FS * 2.5;
            if (h <= avail) {
                ensure(h);
                page.drawImage(img.embedded, { x: M, y: y - h, width: w, height: h });
                y -= h + FS * 0.8;
            } else {
                // Taller than a page: cut it into page-high strips.
                const strips = await sliceImage(pdf, img, avail / h);
                for (const st of strips) {
                    const sh = h * st.frac;
                    ensure(sh);
                    page.drawImage(st.embedded, { x: M, y: y - sh, width: w, height: sh });
                    y -= sh + FS * 0.3;
                }
                y -= FS * 0.5;
            }
            continue;
        }

        const heading = b.type === 'heading';
        const font = heading ? fonts.bold : b.mono ? fonts.mono : fonts.sans;
        const size = heading ? FS * 1.2 : b.mono ? FS * 0.9 : FS;
        const lh   = heading ? size * 1.4 : size * 1.35;
        const color = b.tone === 'error' ? rgb(...ERR) : b.tone === 'muted' ? rgb(...DIM) : rgb(...INK);
        const pad = b.mono ? FS * 0.45 : 0;
        if (heading) y -= FS * 0.4;
        const lines = wrapText(b.text, font, size, colW - 2 * pad);
        lines.forEach((line, i) => {
            const first = i === 0, last = i === lines.length - 1;
            const h = lh + (first ? pad : 0) + (last ? pad : 0);
            if (y - h < bottom) newPage();
            if (b.mono) {
                // Shaded per line, so a code block can break across pages.
                page.drawRectangle({ x: M, y: y - h, width: colW, height: h, color: rgb(...CODEBG) });
            }
            const baseline = y - (first ? pad : 0) - size;
            if (line) page.drawText(line, { x: M + pad, y: baseline, size, font, color });
            y -= h;
        });
        y -= heading ? FS * 0.3 : FS * 0.7;
    }

    // Footer.
    pages.forEach((p, i) => {
        const t = `${sec.from || 'Widget'}  ·  ${i + 1} / ${pages.length}`;
        const fw = fonts.sans.widthOfTextAtSize(t, FS * 0.7);
        p.drawText(t, { x: W - M - fw, y: M * 0.6, size: FS * 0.7, font: fonts.sans, color: rgb(...FAINT) });
    });
}

// Images in flowed pages may need slicing, which needs the bitmap — keep it.
async function embedAnyForFlow(pdf, src) {
    if (typeof src !== 'string') return null;
    try {
        const img = await loadImage(src);
        const embedded = await embedAny(pdf, src, img.naturalWidth || 1200);
        if (!embedded) return null;
        return { embedded, img, width: embedded.width, height: embedded.height };
    } catch (_) { return null; }
}

async function sliceImage(pdf, im, fracPerStrip) {
    const { img } = im;
    const W = img.naturalWidth, H = img.naturalHeight;
    const stripH = Math.max(1, Math.floor(H * fracPerStrip));
    const out = [];
    for (let y0 = 0; y0 < H; y0 += stripH) {
        const h = Math.min(stripH, H - y0);
        const c = document.createElement('canvas');
        c.width = W; c.height = h;
        c.getContext('2d').drawImage(img, 0, y0, W, h, 0, 0, W, h);
        out.push({ embedded: await pdf.embedPng(c.toDataURL('image/png')), frac: h / H });
    }
    return out;
}
