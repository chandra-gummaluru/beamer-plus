// Top-right: the session's buttons — Open, Edit, Save, Close session.
//
//   Open    browse the folder you open presentations from (library/ui.js)
//   Edit    the editor (edit mode's own button closes it, top-right)
//   Save    the Save window: folder, file name, what to save
//   Close   back to the start page, where "Last Session" brings this back
//
// Edit and Save need an open presentation. Opening is also a click on the
// empty slide, or dropping a file on the window.

import { bus } from '../core/events.js';
import { openPresentation, savePresentation } from '../library/ui.js';
import { openUpload } from './uploader.js';
import { isRecording, stopRecording } from './recorder.js';

let appState = null;

export function initSessionButtons(state) {
    appState = state;
    const $ = id => document.getElementById(id);
    $('session-open-btn')?.addEventListener('click', () => openPresentation());
    $('session-edit-btn')?.addEventListener('click', () => $('edit-mode-btn')?.click());
    $('session-save-btn')?.addEventListener('click', () => savePresentation());
    $('session-close-btn')?.addEventListener('click', closeSession);
    $('stage-empty-open')?.addEventListener('click', () => openUpload());
    bus.on('deck:loaded', refresh);
    refresh();
}

function refresh() {
    const deck = !!appState?.zipFile;
    for (const id of ['session-edit-btn', 'session-save-btn']) {
        const b = document.getElementById(id);
        if (b) b.disabled = !deck;
    }
}

// Back to the start page. The presentation is kept in this browser as it is
// now (annotations and all), so "Last Session" there brings it back.
function closeSession() {
    const go = async () => {
        if (isRecording()) await stopRecording();
        bus.emit('session:ending');
        await window.BeamerLastSession?.flush?.();
        window.location.href = '/';
    };
    if (!appState.zipFile && !isRecording()) { go(); return; }
    window.BeamerModal?.show({
        kind: 'warning',
        title: 'Close this session?',
        message: `You’ll go back to the start page${isRecording() ? ' (the recording stops and is kept)' : ''}. `
            + '“Last Session” there picks up where you left off.',
        buttons: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Close session', kind: 'ok', onClick: go }],
    });
}
