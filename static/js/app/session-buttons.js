// Top-right: the session's buttons — Open, Edit, Save, Close session.
//
//   Open    browse the folder you open presentations from (library/ui.js)
//   Edit    the editor (edit mode's own button closes it, top-right)
//   Save    the Save window: folder, file name, what to save
//   Close   back to the start page
//
// Edit and Save need an open presentation. Opening is also a
// file dropped on the window.

import { bus } from '../core/events.js';
import { openPresentation, savePresentation } from '../library/ui.js';
import { isRecording, stopRecording } from './recorder.js';

let appState = null;

export function initSessionButtons(state) {
    appState = state;
    const $ = id => document.getElementById(id);
    $('session-open-btn')?.addEventListener('click', () => openPresentation());
    $('session-edit-btn')?.addEventListener('click', () => $('edit-mode-btn')?.click());
    $('session-save-btn')?.addEventListener('click', () => savePresentation());
    $('session-close-btn')?.addEventListener('click', closeSession);
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

// Back to the start page (asks first when a presentation is open: anything
// not saved is lost).
function closeSession() {
    const go = async () => {
        if (isRecording()) await stopRecording();
        bus.emit('session:ending');
        window.location.href = '/';
    };
    if (!appState.zipFile && !isRecording()) { go(); return; }
    window.BeamerModal?.show({
        kind: 'warning',
        title: 'Close this session?',
        message: `You’ll go back to the start page${isRecording() ? ' (the recording stops and is kept)' : ''}. `
            + 'Anything you haven’t saved will be lost.',
        buttons: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Close session', kind: 'ok', onClick: go }],
    });
}
