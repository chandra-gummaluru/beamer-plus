// Thumbnails — render slide-nav items, attach click handlers.
import { bus } from '../core/events.js';
import { applyPaper } from './paper.js';

export function initThumbnails(state) {
    bus.on('slides:loaded', (slides) => render(slides, state));
}

function render(slides, state) {
    const host = document.getElementById('slide-nav-slides');
    if (!host) return;
    host.innerHTML = '';
    state.totalSlides = slides.length;

    slides.forEach((s, i) => {
        const item = document.createElement('div');
        item.className = 'slide-nav-item';
        item.dataset.index = String(i);

        // ── View slides ────────────────────────────────────────────
        // The number shown under the card (see .slide-nav-item::after).
        item.dataset.label = s.label || String(i + 1);

        if (s.kind === 'view') {
            const preview = document.createElement('div');
            preview.className = 'slide-preview slide-preview-view';
            preview.dataset.slideNumber = s.label || String(i + 1);
            if (s.customTitle) {
                preview.classList.add('slide-preview--titled');
                const t = document.createElement('span');
                t.className = 'slide-preview-title';
                t.textContent = s.customTitle;
                preview.appendChild(t);
                item.appendChild(preview);
                item.addEventListener('click', () => {
                    if (document.body.classList.contains('edit-mode')) bus.emit('view:select', i);
                    bus.emit('slide:goto', i);
                });
                host.appendChild(item);
                return;
            }

            const leftPane = document.createElement('div');
            leftPane.className = 'view-preview-pane';
            leftPane.textContent = s.viewLeftLabel ?? '?';
            leftPane.classList.toggle('is-missing', !!s.viewLeftMissing);

            const sep = document.createElement('div');
            sep.className = 'view-preview-sep';

            const rightPane = document.createElement('div');
            rightPane.className = 'view-preview-pane';
            rightPane.textContent = s.viewRightLabel ?? '?';
            rightPane.classList.toggle('is-missing', !!s.viewRightMissing);

            preview.appendChild(leftPane);
            preview.appendChild(sep);
            preview.appendChild(rightPane);
            item.appendChild(preview);

            // Edit mode → show config panel AND render split preview
            // Presentation mode → activate the split layout
            item.addEventListener('click', () => {
                if (document.body.classList.contains('edit-mode')) {
                    bus.emit('view:select', i);  // sets _selectedViewIdx first (sync)
                    bus.emit('slide:goto', i);   // then triggers async rendering
                } else {
                    bus.emit('slide:goto', i);
                }
            });

            host.appendChild(item);
            return; // skip split zones for view slides
        }

        // ── Regular slides ─────────────────────────────────────────
        const preview = document.createElement('div');
        preview.className = 'slide-preview' +
            (s.kind === 'widget' ? ' slide-preview-widget' :
             s.kind === 'label'  ? ' slide-preview-label'  : '');
        const lbl = s.label || String(i + 1);
        preview.dataset.slideNumber = lbl;
        if (s.customTitle) {
            // A presenter-given title replaces the thumbnail on the card.
            preview.classList.add('slide-preview--titled');
            const t = document.createElement('span');
            t.className = 'slide-preview-title';
            t.textContent = s.customTitle;
            preview.appendChild(t);
        } else if (s.thumbUrl) {
            const img = document.createElement('img');
            img.src = s.thumbUrl;
            img.alt = s.title || `Slide ${lbl}`;
            preview.appendChild(img);
        } else {
            const span = document.createElement('span');
            span.textContent = s.title || `Slide ${lbl}`;
            preview.appendChild(span);
            if (s.paper) applyPaper(preview, s.paper, { thumb: true });
        }
        item.appendChild(preview);

        // Split-view left/right selection zones
        const leftZone  = document.createElement('div');
        leftZone.className  = 'slide-split-zone slide-split-zone--left';
        const rightZone = document.createElement('div');
        rightZone.className = 'slide-split-zone slide-split-zone--right';
        item.appendChild(leftZone);
        item.appendChild(rightZone);

        // Non-split mode: whole item navigates to this slide
        item.addEventListener('click', () => bus.emit('slide:goto', i));

        // Split-mode zones: stopPropagation prevents the item handler above from firing
        leftZone.addEventListener('click', (e) => {
            e.stopPropagation();
            if (document.body.classList.contains('edit-mode')) return;
            if (!leftZone.classList.contains('is-disabled')) bus.emit('slide:goto', i);
        });
        rightZone.addEventListener('click', (e) => {
            e.stopPropagation();
            if (document.body.classList.contains('edit-mode')) return;
            if (!rightZone.classList.contains('is-disabled')) bus.emit('slide:goto-right', i);
        });

        host.appendChild(item);
    });
    if (state.currentSlide < slides.length) {
        host.children[state.currentSlide]?.classList.add('current-slide');
    }

    // Edit mode: a delete button in each preview's top-right corner, shown on
    // hover (CSS). Two clicks — the first arms it — since there's no undo.
    Array.from(host.children).forEach((item) => {
        const i = parseInt(item.dataset.index, 10);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'slide-del-btn';
        del.title = 'Delete slide';
        del.setAttribute('aria-label', 'Delete slide');
        del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>';
        // Don't let a press on the button start a drag-to-reorder.
        del.addEventListener('pointerdown', (e) => e.stopPropagation());
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!del.classList.contains('is-armed')) {
                del.classList.add('is-armed');
                del.title = 'Click again to delete';
                setTimeout(() => { if (del.isConnected) { del.classList.remove('is-armed'); del.title = 'Delete slide'; } }, 3000);
                return;
            }
            bus.emit('slide:delete', i);
        });
        item.appendChild(del);
    });
}
