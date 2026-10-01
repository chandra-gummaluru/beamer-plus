// The download button's chooser: the presentation itself (the ZIP Beamer+
// reopens) or the notes version (one flat PDF with everything drawn in).
import { savePresentation } from './save.js';
import { downloadNotes } from './notes-export.js';

const ICONS = {
    zip:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/><path d="M8 10.5l2.5 2.5L16 8"/></svg>',
    notes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
};

const CHOICES = [
    { key: 'zip',   title: 'Presentation', format: 'ZIP',
      desc: 'Slides, widgets, media and annotations — reopen and keep presenting in Beamer+.',
      run: savePresentation },
    { key: 'notes', title: 'Notes', format: 'PDF',
      desc: 'One PDF with everything drawn in: your annotations, each widget as it is now, media and poll results.',
      run: downloadNotes },
];

export function openDownloadMenu() {
    const root = document.createElement('div');
    root.className = 'download-choices';
    for (const c of CHOICES) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'download-choice';
        card.dataset.choice = c.key;
        card.innerHTML = `<span class="download-choice-icon">${ICONS[c.key]}</span>
            <span class="download-choice-text">
                <span class="download-choice-title"></span>
                <span class="download-choice-desc"></span>
            </span>
            <span class="download-choice-format"></span>`;
        card.querySelector('.download-choice-title').textContent = c.title;
        card.querySelector('.download-choice-desc').textContent = c.desc;
        card.querySelector('.download-choice-format').textContent = c.format;
        card.addEventListener('click', () => {
            window.BeamerModal?.close();
            c.run();
        });
        root.appendChild(card);
    }
    window.BeamerModal?.show({
        kind: 'info',
        title: 'Download',
        body: root,
        buttons: [{ label: 'Cancel', kind: 'cancel' }],
    });
}
