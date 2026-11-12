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
//     each slide at most once in the whole PDF (see notesSlideOrder). A
//     split widget (one widget across a view's two slides) is printed once,
//     laid out across both, and each half drawn on its own slide.
//   · Text is set in the slides' own faces (Computer Modern Sans and
//     Typewriter, static/vendor/fonts — fonts-cm.css's subset as TTF), in the widgets' colours, so the pages
//     a widget adds read as part of the deck. If those can't be loaded, the
//     standard PDF fonts stand in.
import { ctx } from './context.js';
import { bus } from '../core/events.js';
import { configKeyOf, getSlideLabels } from '../slides/structure.js';
import { requestWidgetStates, printWidget } from '../core/iframe-widget-renderer.js';
import { PAPER_SPACING, PAPER_THICKNESS, PAPER_COLORS, normalizePaper } from '../slides/paper.js';

const PDFLIB_SRC  = '/static/vendor/pdf-lib.min.js';
const FONTKIT_SRC = '/static/vendor/fontkit.umd.min.js';
const CM_FONTS    = '/static/vendor/fonts/';

// Beamer's default 4:3 page (128 mm × 96 mm), for a deck with no PDF page
// to take the size from.
const DEFAULT_PAGE = [362.83, 272.13];

// Audio players are a fixed 40px tall on stage, whatever the slide's size.
const AUDIO_PX = 40;

// The widgets' palette (widget-base.css), so printed widgets and the pages
// they add look like the widgets on stage.
const hex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const INK    = hex('#1a1a18');   // --text
const DIM    = hex('#6b6b65');   // --text-2
const FAINT  = hex('#aeaea5');   // --text-3
const RULE   = hex('#d4d4cf');   // --border-med
const WASH   = hex('#f9f9f8');   // --bg-subtle
const CODEBG = hex('#f5f5f4');   // code blocks
const ERR    = hex('#c0392b');   // --err
const MARK   = hex('#f7c548');   // the deck's highlighter yellow

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

let _fontkitReady = null;
function loadFontkit() {
    if (window.fontkit) return Promise.resolve(window.fontkit);
    if (!_fontkitReady) {
        _fontkitReady = new Promise((ok, bad) => {
            const s = document.createElement('script');
            s.src = FONTKIT_SRC;
            s.onload  = () => window.fontkit ? ok(window.fontkit) : bad(new Error('fontkit failed to initialise'));
            s.onerror = () => { _fontkitReady = null; bad(new Error('Could not load fontkit')); };
            document.head.appendChild(s);
        });
    }
    return _fontkitReady;
}

// The slides' faces: the same subset fonts-cm.css inlines as WOFF2, as
// TrueType (fontkit can't subset WOFF2, and a PDF can't carry it).
let _cmBytes = null;
function cmFontBytes() {
    if (!_cmBytes) {
        const get = (f) => fetch(CM_FONTS + f).then(r => {
            if (!r.ok) throw new Error(`${f}: ${r.status}`);
            return r.arrayBuffer();
        });
        _cmBytes = Promise.all(['cm-sans.ttf', 'cm-sans-bold.ttf', 'cm-typewriter.ttf'].map(get))
            .then(([sans, bold, mono]) => ({ sans, bold, mono }))
            .catch(err => { _cmBytes = null; throw err; });
    }
    return _cmBytes;
}

// { sans, bold, mono }: Computer Modern if it can be had, else Helvetica and
// Courier. A custom font carries the set of characters it can draw.
async function embedFonts(pdf, PDFLib) {
    try {
        const [fk, bytes] = await Promise.all([loadFontkit(), cmFontBytes()]);
        pdf.registerFontkit(fk);
        const fonts = {};
        for (const k of ['sans', 'bold', 'mono']) {
            const f = await pdf.embedFont(bytes[k], { subset: true });
            f.bwChars = new Set(f.getCharacterSet());
            fonts[k] = f;
        }
        return fonts;
    } catch (err) {
        console.warn('[notes] Computer Modern unavailable, using the standard fonts', err);
        const { StandardFonts } = PDFLib;
        return {
            sans: await pdf.embedFont(StandardFonts.Helvetica),
            bold: await pdf.embedFont(StandardFonts.HelveticaBold),
            mono: await pdf.embedFont(StandardFonts.Courier),
        };
    }
}

/* ─── progress ─────────────────────────────────────────────────── */

function showProgress(message) {
    const modal = window.BeamerModal;
    const msgEl = modal?.open?.querySelector('.custom-modal-message');
    if (modal?.open?.classList.contains('modal-loading') && msgEl) { msgEl.textContent = String(message || '').replace(/\s*(…|\.\.\.)\s*$/, ''); return; }
    modal?.show({ kind: 'loading', title: 'Building Notes…', message });
}

/* ─── text ─────────────────────────────────────────────────────── */
// A font draws only the characters it has: the CM faces carry Latin-1 and
// typographic punctuation, the standard PDF fonts WinAnsi (and pdf-lib
// throws on anything else). Map the usual suspects to ASCII and replace the
// rest.
const _WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const _TRANSLIT = {
    '−': '-', '‐': '-', '‑': '-', '→': '->', '←': '<-', '⇒': '=>', '↔': '<->',
    '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '∞': 'inf', '×': '×', '·': '·',
    '…': '…', ' ': ' ', ' ': ' ', ' ': ' ', '​': '',
    '✓': 'v', '✗': 'x', '✕': 'x', '•': '•', '▶': '>', '►': '>', '★': '*',
    'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'θ': 'theta',
    'λ': 'lambda', 'μ': 'mu', 'π': 'pi', 'σ': 'sigma', 'Σ': 'Sum', 'Δ': 'Delta',
};
function drawable(font, ch, c) {
    if (font?.bwChars) return font.bwChars.has(c);
    return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || _WINANSI_EXTRA.has(ch);
}
function cleanText(s, font) {
    let out = '';
    for (const ch of String(s ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ')) {
        const c = ch.codePointAt(0);
        if (ch === '\n' || drawable(font, ch, c)) out += ch;
        else if (c < 0x20) continue;
        else if (_TRANSLIT[ch] !== undefined) {
            for (const t of _TRANSLIT[ch]) out += drawable(font, t, t.codePointAt(0)) ? t : '?';
        }
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
    return cleanText(text, font).split('\n').flatMap(l => wrapLine(l, font, size, maxW));
}

function fitText(text, font, size, maxW) {
    let t = cleanText(text, font).replace(/\n/g, ' ');
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

const baseName = (p) => String(p || '').split('/').pop() || 'file';

/* ─── the exporter ─────────────────────────────────────────────── */

let _busy = false;

/** The notes PDF as a Blob (Save presentation writes it). Shows its own
 *  progress in the loading modal; leaves the modal open when done. */
export async function buildNotesPdf() {
    const s = ctx.state;
    if (!s.zipFile) throw new Error('No presentation loaded.');
    if (_busy) throw new Error('Notes are already being built.');
    _busy = true;
    showProgress('Preparing…');

    try {
        // Commit what's on the canvas so the latest strokes are in.
        bus.emit('annotations:flush');

        const PDFLib = await loadPdfLib();
        const { PDFDocument, rgb } = PDFLib;
        const out = await PDFDocument.create();
        out.setTitle('Lecture notes');
        out.setCreator('Beamer+');
        out.setProducer('Beamer+ (pdf-lib)');

        const fonts = await embedFonts(out, PDFLib);

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
        const halvesOn = await splitHalvesIn(s.slideStructure, slides);
        const allIds = [];
        for (const cfg of configs.values()) for (const w of cfg?.widgets || []) if (w?.id != null) allIds.push(String(w.id));
        for (const h of halvesOn.values()) allIds.push(String(h.w.id));
        const states = allIds.length ? await requestWidgetStates(allIds, 2000) : {};
        const slideAspect = blankSize[1] / blankSize[0];
        const splitPrints = new Map();   // widget id → its print, cut in two (once each)
        const halvesLeft  = new Map();   // widget id → halves not drawn yet
        for (const h of halvesOn.values()) halvesLeft.set(String(h.w.id), (halvesLeft.get(String(h.w.id)) || 0) + 1);

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
                        drawPlaceholder(page, r, res.label, res.ok ? res.note || 'Nothing to show' : 'Interactive widget', fonts, rgb);
                    }
                    for (const sec of res.pages || []) extraSections.push({ ...sec, from: res.label });
                    const covers = full || (d.x <= 0.005 && d.y <= 0.005 &&
                                            d.x + d.width >= 0.995 && d.y + d.height >= 0.995);
                    if (covers) fillsSlide = res;
                }
            }

            // ── A split widget's half, over the slide's own items ────
            const half = halvesOn.get(sl.i);
            if (half) {
                const id = String(half.w.id);
                if (!splitPrints.has(id)) {
                    splitPrints.set(id, printSplit(half.w, half.view, states[id], refW, refH, slideAspect));
                }
                const sp = await splitPrints.get(id);
                const r = rectOf(0, 0, 1, 1);
                const img = sp.halves[half.side] ? await embedAny(out, sp.halves[half.side]) : null;
                if (img) {
                    const c = containRect(img.width, img.height, r);
                    page.drawImage(img, { x: c.x, y: c.y, width: c.w, height: c.h });
                } else {
                    const ph = rectOf(0.06, 0.08, 0.88, 0.84);
                    drawPlaceholder(page, ph, sp.label, `Split widget (${half.side} half)`, fonts, rgb);
                }
                // Its own pages follow the last of its halves.
                const left = halvesLeft.get(id) - 1;
                halvesLeft.set(id, left);
                if (!left) for (const sec of sp.pages || []) extraSections.push({ ...sec, from: sp.label });
            }

            // ── Ink on top of everything, as on stage ────────────────
            const ann = s.annotations?.[sl.i];
            const inked = await hasInk(ann);

            // A widget that fills the slide and whose pages are the slide
            // over again, readably (it says so: replaceSlide) would otherwise
            // appear twice. Keep only the pages — unless the slide carries
            // more than the widget (other media, or ink drawn over it).
            const replaced = items.length === 1 && !half && fillsSlide?.ok && fillsSlide.replaceSlide &&
                             fillsSlide.pages?.length > 0 && !inked;
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
        return new Blob([bytes], { type: 'application/pdf' });
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
function notesSlideOrder(structure, labels = getSlideLabels(structure)) {
    const n = structure.length;
    const out = [];
    const done = new Set();
    // A pane hidden on its own has no label of its own: it goes by its view's.
    const add = (i, fallback = '') => {
        const obj = structure[i];
        if (!obj || obj.type === 'view' || done.has(i)) return;
        done.add(i);
        out.push({ obj, i, label: labels[i] || fallback });
    };
    structure.forEach((obj, i) => {
        if (!obj || obj.hidden) return;
        if (obj.type !== 'view') { add(i); return; }
        for (const p of [obj.left, obj.right]) {
            if (Number.isInteger(p) && p >= 0 && p < n) add(p, labels[i]);
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

function printHost() {
    return document.getElementById('notes-print-host') || (() => {
        const el = document.createElement('div');
        el.id = 'notes-print-host';
        Object.assign(el.style, { position: 'fixed', left: '0', top: '0', width: '0', height: '0', overflow: 'visible', zIndex: '-1' });
        document.body.appendChild(el);
        return el;
    })();
}

// Which notes slides carry a half of a split widget: slide index →
// { w, view, side }. A split widget lives in its view's config; its halves
// are the view's two slides. A slide shows one split widget's half at most
// (the earliest view in the deck, as on stage when no view is showing), and
// only views that are themselves in the notes count.
async function splitHalvesIn(structure, slides) {
    const inNotes = new Set(slides.map(sl => sl.i));
    const out = new Map();
    for (const v of structure) {
        if (v?.type !== 'view' || v.hidden) continue;
        const cfg = await readConfig(configKeyOf(v));
        const w = (cfg?.widgets || []).find(x => x && x.split && x.id != null);
        if (!w) continue;
        for (const side of ['left', 'right']) {
            const i = v[side];
            if (Number.isInteger(i) && inNotes.has(i) && !out.has(i)) out.set(i, { w, view: v, side });
        }
    }
    return out;
}

// A split widget, printed once across both of its slides as they sit side
// by side in the split view on stage, then cut into its two halves:
// { label, halves: { left, right } (PNG data URLs or null), pages }.
async function printSplit(w, view, state, refW, refH, aspect) {
    // Each half is laid out as big as a slide on its own would be on stage,
    // whatever the split's ratio. Each half fills a page, so a half laid out
    // at its on-stage share would be blown up on paper: the narrower slide's
    // 2px lines came out several times thicker than the other half's, and its
    // text much bigger. At full size both pages match a full-slide widget.
    const GAP = 12;
    const area = document.getElementById('main-content')?.getBoundingClientRect();
    const AW = area?.width  > 200 ? area.width - 2 * GAP  : refW;
    const AH = area?.height > 150 ? area.height - 2 * GAP : refH;
    const fit = (paneW) => {
        const sw = Math.min(paneW, AH / aspect);
        return { w: sw, h: sw * aspect };
    };
    const L = fit(AW), R = fit(AW);
    const H = Math.max(L.h, R.h);
    const left  = { x: 0, y: (H - L.h) / 2, w: L.w, h: L.h };
    const right = { x: L.w + GAP, y: (H - R.h) / 2, w: R.w, h: R.h };
    const box = { width: right.x + right.w, height: H };
    // Each half fills a page: print it about as sharp as a full slide.
    const scale = Math.min(3, Math.max(2, 2 * refW / Math.min(L.w, R.w)));
    const res = await printWidget(w, { zipFile: ctx.state.zipFile, box, state, split: { left, right }, scale, host: printHost() });
    const halves = { left: null, right: null };
    if (res.ok && res.image) {
        try {
            const img = await loadImage(res.image);
            const k = img.naturalWidth / box.width;
            for (const [side, r] of [['left', left], ['right', right]]) {
                const c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(r.w * k)); c.height = Math.max(1, Math.round(r.h * k));
                const g = c.getContext('2d');
                g.drawImage(img, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, c.width, c.height);
                halves[side] = c.toDataURL('image/png');
            }
        } catch (err) { console.warn('[notes] could not cut a split widget', err); }
    }
    return { label: res.label, halves, pages: res.ok ? res.pages || [] : [] };
}

async function printOne(w, state, refW, refH) {
    const host = printHost();
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

// A rectangle with rounded corners, (x, y) its bottom-left in PDF points.
// opts as drawSvgPath's: color, borderColor, borderWidth, opacity.
function roundRect(page, x, y, w, h, r, opts) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    const k = r * 0.4477;   // the control points of a quarter circle
    // drawSvgPath's y axis points down, from the given origin: the top left.
    const d = `M ${r} 0 H ${w - r} C ${w - k} 0 ${w} ${k} ${w} ${r} V ${h - r} ` +
              `C ${w} ${h - k} ${w - k} ${h} ${w - r} ${h} H ${r} C ${k} ${h} 0 ${h - k} 0 ${h - r} ` +
              `V ${r} C 0 ${k} ${k} 0 ${r} 0 Z`;
    page.drawSvgPath(d, { x, y: y + h, ...opts });
}

function labelSize(r, pageW) {
    return Math.max(pageW / 90, Math.min(pageW / 34, r.w / 16, r.h / 5));
}

// A widget that couldn't be printed: a card in the widgets' own style, with
// a small widget mark, its name and why it's blank.
function drawPlaceholder(page, r, title, sub, fonts, rgb) {
    const pageW = page.getWidth();
    roundRect(page, r.x, r.y, r.w, r.h, Math.min(pageW / 90, r.w / 8, r.h / 8), {
        color: rgb(...WASH), borderColor: rgb(...RULE), borderWidth: Math.max(0.4, pageW / 800),
    });
    const fs = labelSize(r, pageW);
    const t1 = fitText(title, fonts.bold, fs, r.w * 0.86);
    const t2 = fitText(sub, fonts.sans, fs * 0.72, r.w * 0.86);
    const w1 = fonts.bold.widthOfTextAtSize(t1, fs);
    const w2 = fonts.sans.widthOfTextAtSize(t2, fs * 0.72);
    // The mark: a little widget window (its bar, a body) above the name —
    // only where there's room for it.
    const mark = r.h > fs * 6;
    const cy = r.y + r.h / 2 - (mark ? fs * 0.9 : 0);
    if (mark) {
        const mw = fs * 2.2, mh = fs * 1.6, mx = r.x + (r.w - mw) / 2, my = cy + fs * 1.5;
        const line = { borderColor: rgb(...FAINT), borderWidth: fs / 11 };
        roundRect(page, mx, my, mw, mh, fs * 0.22, { color: rgb(1, 1, 1), ...line });
        page.drawLine({ start: { x: mx, y: my + mh - fs * 0.45 }, end: { x: mx + mw, y: my + mh - fs * 0.45 },
                        thickness: fs / 11, color: rgb(...FAINT) });
        page.drawRectangle({ x: mx + fs * 0.35, y: my + fs * 0.32, width: mw * 0.45, height: fs * 0.16, color: rgb(...MARK) });
    }
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
        page.drawSvgPath(`M ${-k * 0.7} ${-k} L ${k * 1.1} 0 L ${-k * 0.7} ${k} Z`, { x: cx, y: cy, color: rgb(1, 1, 1) });
    }
    // The caption: a pill in the box's bottom-left corner.
    const fs = Math.max(pageW / 110, Math.min(pageW / 60, r.h / 10));
    const inset = fs * 0.5;
    const cap = fitText(`${kind}: ${name}`, fonts.sans, fs, r.w - fs * 1.6 - inset * 2);
    const cw = fonts.sans.widthOfTextAtSize(cap, fs);
    const ph = fs * 1.6;
    roundRect(page, r.x + inset, r.y + inset, Math.min(r.w - inset * 2, cw + fs * 1.2), ph, ph / 2,
              { color: rgb(...INK), opacity: 0.72 });
    page.drawText(cap, { x: r.x + inset + fs * 0.6, y: r.y + inset + fs * 0.5, size: fs, font: fonts.sans, color: rgb(1, 1, 1) });
}

function drawAudioBar(page, r, name, fonts, rgb) {
    const h = r.h;
    roundRect(page, r.x, r.y, r.w, h, h / 2, { color: rgb(...WASH), borderColor: rgb(...RULE), borderWidth: h / 40 });
    // Speaker mark.
    const u = h / 10, x0 = r.x + h * 0.45, cy = r.y + h / 2;
    page.drawSvgPath(`M 0 ${-u} L ${u} ${-u} L ${u * 2.4} ${-u * 2.2} L ${u * 2.4} ${u * 2.2} L ${u} ${u} L 0 ${u} Z`,
                     { x: x0, y: cy, color: rgb(...DIM) });
    const fs = h * 0.36;
    const tx = x0 + u * 3.6;
    page.drawText(fitText(`Audio: ${name}`, fonts.sans, fs, r.x + r.w - tx - h * 0.4),
                  { x: tx, y: cy - fs * 0.35, size: fs, font: fonts.sans, color: rgb(...INK) });
}

/* ─── a widget's extra pages ───────────────────────────────────── */
// A section is { title, blocks: [ heading | text | image ] }. It starts on a
// new page the size of the slides and flows over as many as it needs; an
// image taller than a page is sliced. Sizes scale with the page, so a small
// Beamer page and a big one come out alike when viewed to fit.
//
// The pages are set like the deck: the title highlighted in the deck's
// yellow, headings marked with it, code in the widgets' boxed code blocks
// (Computer Modern Typewriter). No running header or footer: the pages sit
// right after their slide, which says where they came from.

// The column width an image block's CSS pixels are measured against: an
// image this wide fills the column, a narrower one keeps its proportion.
const COLUMN_PX = 760;

async function flowSection(pdf, sec, slideLabel, [W, H], fonts, rgb) {
    const M    = W * 0.07;
    const FS   = W / 50;
    const colW = W - 2 * M;
    const top  = H - M * 0.8;
    const bottom = M * 0.8;

    let page, y;
    const newPage = () => {
        page = pdf.addPage([W, H]);
        page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1) });
        y = top;
    };
    const ensure = (h) => { if (y - h < bottom) newPage(); };

    newPage();
    if (sec.title) {
        // The deck's frame title: bold, on a band of highlighter yellow.
        const ts = FS * 1.55, pad = ts * 0.22;
        for (const line of wrapText(sec.title, fonts.bold, ts, colW - pad * 2)) {
            ensure(ts * 1.45);
            const tw = fonts.bold.widthOfTextAtSize(line, ts);
            page.drawRectangle({ x: M, y: y - ts * 1.22, width: tw + pad * 2, height: ts * 1.22, color: rgb(...MARK) });
            page.drawText(line, { x: M + pad, y: y - ts * 0.92, size: ts, font: fonts.bold, color: rgb(...INK) });
            y -= ts * 1.3;
        }
        y -= FS * 0.9;
    }

    for (const b of sec.blocks || []) {
        if (b.type === 'image') {
            const img = await embedAnyForFlow(pdf, b.src);
            if (!img) continue;
            const natW = b.width || img.width;
            const avail = top - bottom - FS * 2.5;
            let w = Math.min(colW, colW * natW / (sec.columnWidth || COLUMN_PX));
            if (b.fit) {
                // A picture that mustn't be cut (a diagram) is shrunk to the
                // room left on this page, under its heading — or, if that's
                // under half a page, to the next page — never sliced.
                if (y - bottom < avail / 2 && w * (img.height / img.width) > y - bottom) newPage();
                const room = y - bottom - FS * 0.2;
                if (w * (img.height / img.width) > room) w = room * (img.width / img.height);
            }
            const h = w * (img.height / img.width);
            if (h <= avail || b.fit) {
                ensure(h);
                page.drawImage(img.embedded, { x: M, y: y - h, width: w, height: h });
                y -= h + FS * 0.9;
            } else {
                // Taller than a page: cut it into page-high strips.
                const strips = await sliceImage(pdf, img, avail / h);
                for (const st of strips) {
                    const sh = h * st.frac;
                    ensure(sh);
                    page.drawImage(st.embedded, { x: M, y: y - sh, width: w, height: sh });
                    y -= sh + FS * 0.3;
                }
                y -= FS * 0.6;
            }
            continue;
        }

        const color = b.tone === 'error' ? rgb(...ERR) : b.tone === 'muted' ? rgb(...DIM) : rgb(...INK);

        if (b.type === 'heading') {
            // Bold, underlined with a stroke of the highlighter.
            const size = FS * 1.15, lh = size * 1.4;
            y -= FS * 0.5;
            const lines = wrapText(b.text, fonts.bold, size, colW);
            ensure(lh * Math.min(lines.length, 2) + FS * 2.5);   // never alone at a page's foot
            lines.forEach((line, i) => {
                ensure(lh);
                const base = y - size;
                if (i === lines.length - 1) {
                    const tw = fonts.bold.widthOfTextAtSize(line, size);
                    page.drawRectangle({ x: M - size * 0.1, y: base - size * 0.18, width: tw + size * 0.2, height: size * 0.36,
                                         color: rgb(...MARK) });
                }
                page.drawText(line, { x: M, y: base, size, font: fonts.bold, color });
                y -= lh;
            });
            y -= FS * 0.25;
            continue;
        }

        if (b.mono) {
            // A code block as the widgets draw one: an inked, rounded box.
            // One that runs over a page is closed there and picked up on the
            // next, in a box of its own.
            const size = FS * 0.88, lh = size * 1.36;
            const pad = FS * 0.6, rad = FS * 0.45, bw = W / 520;
            // One box may mix tones (a shell transcript: banner, output,
            // errors): b.runs is [{ text, tone }], each run its own colour.
            const toneOf = (t) => t === 'error' ? rgb(...ERR) : t === 'muted' ? rgb(...DIM) : rgb(...INK);
            const runs = Array.isArray(b.runs) && b.runs.length ? b.runs : [{ text: b.text, tone: b.tone }];
            const lines = [], colors = [];
            for (const r of runs) {
                for (const l of wrapText(r.text, fonts.mono, size, colW - 2 * pad)) { lines.push(l); colors.push(toneOf(r.tone)); }
            }
            let i = 0, fresh = false;
            while (i < lines.length) {
                let n = Math.floor((y - bottom - 2 * pad) / lh);
                const want = Math.min(3, lines.length - i);   // no lone line at a page's foot
                if (n < want && !fresh) { newPage(); fresh = true; continue; }
                n = Math.max(1, Math.min(n, lines.length - i));
                const h = n * lh + 2 * pad;
                roundRect(page, M, y - h, colW, h, rad, { color: rgb(...CODEBG), borderColor: rgb(...INK), borderWidth: bw });
                for (let k = 0; k < n; k++) {
                    const line = lines[i + k];
                    const base = y - pad - k * lh - (lh + size * 0.62) / 2;
                    if (line) page.drawText(line, { x: M + pad, y: base, size, font: fonts.mono, color: colors[i + k] });
                }
                i += n;
                y -= h + FS * 0.25;
                fresh = false;
                if (i < lines.length) { newPage(); fresh = true; }
            }
            y -= FS * 0.55;
            continue;
        }

        const size = FS, lh = size * 1.38;
        for (const line of wrapText(b.text, fonts.sans, size, colW)) {
            ensure(lh);
            if (line) page.drawText(line, { x: M, y: y - size, size, font: fonts.sans, color });
            y -= lh;
        }
        y -= FS * 0.55;
    }
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
