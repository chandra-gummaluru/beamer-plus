// Upload — loading a presentation from a PDF or a saved Beamer+ ZIP.
// Two ways in: the upload button (one file picker that takes either), or
// dropping the file anywhere on the window. Both route by file type and hand
// off through bus events, keeping this decoupled from main.js.
import { bus } from '../core/events.js';

export function initUploader() {
    const input = document.getElementById('upload-presentation');
    document.getElementById('upload-presentation-btn')?.addEventListener('click', () => input?.click());

    input?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) openPresentationFile(file);
    });

    initDropZone();
}

function kindOf(file) {
    const name = (file?.name || '').toLowerCase();
    if (name.endsWith('.pdf') || file?.type === 'application/pdf') return 'pdf';
    if (name.endsWith('.zip') || /zip/.test(file?.type || '')) return 'zip';
    return null;
}

/** Load a PDF or Beamer+ ZIP, whichever `file` is. */
export function openPresentationFile(file) {
    const kind = kindOf(file);
    if (!kind) {
        window.BeamerModal?.show({
            kind: 'error',
            title: 'Can’t open that file',
            message: `“${file?.name || 'This file'}” isn’t a PDF or a Beamer+ ZIP.`,
        });
        return;
    }
    bus.emit(kind === 'pdf' ? 'upload:pdf' : 'upload:zip', file);
}

/* ─── drag and drop ───────────────────────────────────────────── */
// Drop a PDF or ZIP anywhere on the presenter window to load it. Only file
// drags are intercepted (dragging text or an annotation is left alone), and
// only while uploading is allowed at all — the upload button is the source
// of truth for that (split view disables it, for instance). Drops onto a
// widget never reach here: they land in the widget's own iframe.

function uploadAllowed() {
    const btn = document.getElementById('upload-presentation-btn');
    return !!btn && !btn.disabled && !document.body.classList.contains('edit-mode');
}

function hasFiles(e) {
    return Array.from(e.dataTransfer?.types || []).includes('Files');
}

function initDropZone() {
    const overlay = document.getElementById('drop-overlay');
    if (!overlay) return;
    let depth = 0;   // dragenter/leave fire for every child element crossed
    const show = (on) => overlay.classList.toggle('is-visible', on);

    window.addEventListener('dragenter', (e) => {
        if (!hasFiles(e) || !uploadAllowed()) return;
        e.preventDefault();
        depth++;
        show(true);
    });
    window.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        // preventDefault marks this as a drop target; without it the browser
        // would open the file in the tab and throw the session away.
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = uploadAllowed() ? 'copy' : 'none';
    });
    window.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        depth = Math.max(0, depth - 1);
        if (!depth) show(false);
    });
    window.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        show(false);
        if (!uploadAllowed()) return;
        const files = Array.from(e.dataTransfer.files || []);
        const file = files.find(kindOf) || files[0];
        if (file) openPresentationFile(file);
    });
}
