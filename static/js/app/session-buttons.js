// Top-right: the session's buttons.
//
//   Edit    the editor (its own Done button closes it); once a deck is open
//   Close   back to the start page; with a deck open it asks whether to
//           save first (the Save window, then the start page once saved)
//
// There is no Open button: a new session starts with the Open window, which
// stays until a presentation opens (library/ui.js). Dropping a file on the
// window opens one too.

import { bus } from '../core/events.js';
import { savePresentation } from '../library/ui.js';
import { isRecording, stopRecording } from './recorder.js';

let appState = null;
// Set while Close session's "Save…" is under way: a finished save then
// leaves for the start page. Cleared by the other answers.
let leaveAfterSave = false;

export function initSessionButtons(state) {
    appState = state;
    const $ = id => document.getElementById(id);
    $('session-edit-btn')?.addEventListener('click', () => $('edit-mode-btn')?.click());
    $('session-close-btn')?.addEventListener('click', closeSession);
    bus.on('deck:loaded', refresh);
    bus.on('library:saved', () => {
        if (!leaveAfterSave) return;
        leaveAfterSave = false;
        setTimeout(leave, 700);   // long enough to see the "Saved …" toast
    });
    refresh();
}

function refresh() {
    const deck = !!appState?.zipFile;
    const edit = document.getElementById('session-edit-btn');
    if (edit) { edit.hidden = !deck; edit.disabled = !deck; }
}

async function leave() {
    if (isRecording()) await stopRecording();
    bus.emit('session:ending');
    leaving = true;
    window.location.href = '/';
}

// A session is its presentation: it can't go on without one. When the deck
// can't be opened, or isn't there (the page was reloaded or opened from a
// link: the file is only ever in this tab), say so and go back to the start
// page however the message is closed.
let leaving = false;
export function endSession(title, message) {
    window.BeamerModal?.show({
        kind: 'error',
        title,
        message: `${message} You'll go back to the start page to begin a new session.`,
        buttons: [{ label: 'Close', kind: 'ok' }],
        onClose: () => { leave(); },
    });
}

// Reloading (or closing the tab) ends the session, so ask first while a
// presentation is open.
window.addEventListener('beforeunload', (e) => {
    if (leaving || !appState?.zipFile) return;
    e.preventDefault();
    e.returnValue = '';
});

// Back to the start page. With nothing open (and no recording) it just goes;
// otherwise it asks whether to save first.
function closeSession() {
    leaveAfterSave = false;
    if (!appState.zipFile && !isRecording()) { leave(); return; }
    const rec = isRecording();
    if (!appState.zipFile) {
        window.BeamerModal?.show({
            kind: 'warning',
            title: 'Close This Session?',
            message: 'You’ll go back to the start page. The recording stops and is kept.',
            buttons: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Close Session', kind: 'ok', onClick: leave }],
        });
        return;
    }
    window.BeamerModal?.show({
        kind: 'warning',
        title: 'Save Before Closing?',
        message: `You’ll go back to the start page${rec ? ' (the recording stops and is kept)' : ''}. `
            + 'Anything you haven’t saved will be lost.',
        buttons: [
            { label: 'Cancel', kind: 'cancel' },
            { label: 'Don’t Save', kind: 'cancel', onClick: leave },
            { label: 'Save…', kind: 'ok', onClick: () => {
                leaveAfterSave = true;
                // A take in progress is stopped first, so it can be saved too.
                setTimeout(async () => {
                    if (isRecording()) await stopRecording();
                    savePresentation();
                }, 0);
            } },
        ],
    });
}
