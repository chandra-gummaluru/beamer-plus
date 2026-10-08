// The download button's chooser: the presentation itself (the ZIP Beamer+
// reopens) or the notes version (one flat PDF with everything drawn in),
// followed by every screen recording made with the record button.
import { savePresentation } from './save.js';
import { downloadNotes } from './notes-export.js';
import { listRecordings, downloadRecording, deleteRecording, onRecordingsChange,
         isRecording, stopRecording, formatDuration, formatSize } from '../app/recorder.js';

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

    const recSection = document.createElement('div');
    recSection.className = 'download-recordings';
    recSection.hidden = true;
    root.appendChild(recSection);
    const refresh = () => renderRecordings(recSection);
    refresh();
    // Keep the list current while the menu is open (a take finishing, …).
    const off = onRecordingsChange(() => {
        if (!root.isConnected) { off(); return; }
        refresh();
    });

    window.BeamerModal?.show({
        kind: 'info',
        title: 'Download',
        body: root,
        buttons: [{ label: 'Cancel', kind: 'cancel' }],
    });
}

/* ─── recordings ──────────────────────────────────────────────── */

const REC_ICONS = {
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    trash:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>',
    stop:     '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};

let renderSeq = 0;

async function renderRecordings(section) {
    const seq = ++renderSeq;
    let recs = [];
    try { recs = await listRecordings(); }
    catch (err) { console.warn('[download] could not list recordings', err); }
    if (seq !== renderSeq) return;            // a newer render took over

    const live = isRecording();
    section.replaceChildren();
    section.hidden = !recs.length && !live;
    if (section.hidden) return;

    const head = document.createElement('div');
    head.className = 'download-recordings-head';
    const title = document.createElement('span');
    title.className = 'download-recordings-title';
    title.textContent = `Recordings (${recs.length})`;
    head.appendChild(title);
    if (recs.length > 1) {
        const all = document.createElement('button');
        all.type = 'button';
        all.className = 'download-recordings-all';
        all.textContent = 'Download all';
        all.addEventListener('click', async () => {
            all.disabled = true;
            // Oldest first; a short gap so the browser takes each one.
            for (const r of [...recs].reverse()) {
                await downloadRecording(r.id);
                await new Promise(res => setTimeout(res, 700));
            }
            all.disabled = false;
        });
        head.appendChild(all);
    }
    section.appendChild(head);

    const list = document.createElement('div');
    list.className = 'download-recordings-list';
    section.appendChild(list);

    if (live) {
        const row = recordingRow({ name: 'Recording in progress', meta: 'Stop it to download' });
        row.classList.add('is-live');
        const stop = iconButton(REC_ICONS.stop, 'Stop recording');
        stop.addEventListener('click', () => { stop.disabled = true; stopRecording(); });
        row.append(stop, document.createElement('span'));
        list.appendChild(row);
    }

    for (const r of recs) {
        const when = new Date(r.startedAt).toLocaleString([], {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        });
        const parts = [r.deckName && r.deckName !== 'Beamer+' ? r.deckName : null, when,
                       formatDuration(r.durationMs || 0), formatSize(r.size || 0)];
        const row = recordingRow({
            name: r.label + (r.recovered ? ' (recovered)' : ''),
            meta: parts.filter(Boolean).join(' · '),
            title: r.fileName,
        });

        const dl = iconButton(REC_ICONS.download, `Download ${r.fileName}`);
        dl.addEventListener('click', () => downloadRecording(r.id));

        const del = iconButton(REC_ICONS.trash, 'Delete recording');
        del.classList.add('is-delete');
        let armTimer = null;
        del.addEventListener('click', async () => {
            if (!del.classList.contains('is-armed')) {
                // Two clicks to delete: the take is gone for good.
                del.classList.add('is-armed');
                del.title = 'Click again to delete';
                del.style.color = 'var(--danger)';
                clearTimeout(armTimer);
                armTimer = setTimeout(() => {
                    del.classList.remove('is-armed');
                    del.title = 'Delete recording';
                    del.style.color = '';
                }, 3000);
                return;
            }
            del.disabled = true;
            await deleteRecording(r.id);
        });

        row.append(dl, del);
        list.appendChild(row);
    }
}

function recordingRow({ name, meta, title }) {
    const row = document.createElement('div');
    row.className = 'download-recording';
    row.innerHTML = `<span class="download-recording-dot" aria-hidden="true"></span>
        <span class="download-recording-text">
            <span class="download-recording-name"></span>
            <span class="download-recording-meta"></span>
        </span>`;
    row.querySelector('.download-recording-name').textContent = name;
    row.querySelector('.download-recording-meta').textContent = meta;
    if (title) row.title = title;
    return row;
}

function iconButton(svg, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn--ghost';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = svg;
    return b;
}
