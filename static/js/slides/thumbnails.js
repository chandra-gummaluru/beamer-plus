// Thumbnails — render slide-nav items, attach click handlers.
import { bus } from '../core/events.js';

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

            const sep = document.createElement('div');
            sep.className = 'view-preview-sep';

            const rightPane = document.createElement('div');
            rightPane.className = 'view-preview-pane';
            rightPane.textContent = s.viewRightLabel ?? '?';

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
}
