// Top-right: the session menu, behind the session button (the open
// presentation's name, or "Session").
//
//   Session ABC123
//   <presentation> · in <folder>/<subfolder>
//   ───
//   Open a presentation…
//   Edit presentation            (Done editing while editing)
//   Save presentation…    Ctrl+S
//   ───
//   Start recording…             (Stop recording while recording)
//   ───
//   End session
//
// Open and Save browse a folder on this computer (library/ui.js). Edit, Save
// need an open presentation. "End session" goes back to the start page, where
// "Last Session" brings this one back (app/last-session.js).

import { bus } from '../core/events.js';
import { openPresentation, savePresentation, folderLabel } from '../library/ui.js';
import { openUpload } from './uploader.js';
import { getSessionId } from './session.js';
import { openRecorder, stopRecording, isRecording, recordingSupported } from './recorder.js';

const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
    session: svg('<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/>'),
    save: svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
    open: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
    edit: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
    record: '<svg class="session-rec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>',
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>'),
    end: svg('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
    chevron: '<svg class="session-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>',
};
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');

let appState = null;
let menu = null;

export function initSessionMenu(state) {
    appState = state;
    const btn = document.getElementById('session-btn');
    btn?.addEventListener('click', (e) => { e.stopPropagation(); menu ? closeMenu() : openMenu(btn); });
    document.getElementById('stage-empty-open')?.addEventListener('click', () => openUpload());
    bus.on('deck:loaded', refresh);
    bus.on('library:saved', refresh);
    refresh();
}

// Edit mode's own button (top-right while editing) closes it; this opens it.
function toggleEdit() { document.getElementById('edit-mode-btn')?.click(); }

const deckName = () => appState?.target?.name || (appState?.zipFile ? appState.deckName : '') || '';

function refresh() {
    const btn = document.getElementById('session-btn');
    if (!btn) return;
    const name = deckName();
    btn.innerHTML = `<span class="session-mark">${ICON.session}</span><span class="session-name"></span>${ICON.chevron}`;
    btn.querySelector('.session-name').textContent = name || 'Session';
    btn.title = `Session ${getSessionId() || ''}${name ? ` · ${name}` : ''}`;
}

function openMenu(anchor) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'session-menu';
    menu.setAttribute('role', 'menu');

    const head = document.createElement('div');
    head.className = 'session-menu-head';
    head.innerHTML = '<span>Session <b></b></span>';
    head.querySelector('b').textContent = getSessionId() || '';
    const name = deckName();
    if (name) {
        const t = appState.target;
        const where = t?.src === 'folder' ? [folderLabel(), t.dir].filter(Boolean).join('/') : '';
        const sub = document.createElement('span');
        sub.className = 'session-menu-sub';
        sub.textContent = where ? `${name} · in ${where}` : name;
        sub.title = sub.textContent;
        head.appendChild(sub);
    }
    menu.appendChild(head);

    const deck = !!appState.zipFile;
    const editing = !!appState.editMode;
    const recording = isRecording();
    const items = [
        { key: 'open', label: 'Open a presentation…', run: () => openPresentation() },
        { key: 'edit', label: editing ? 'Done editing' : 'Edit presentation', run: toggleEdit, off: !deck },
        { key: 'save', label: 'Save presentation…', kbd: isMac ? '⌘S' : 'Ctrl+S', run: () => savePresentation(), off: !deck },
        { sep: true },
        recording
            ? { key: 'record', icon: 'stop', label: 'Stop recording', run: () => stopRecording() }
            : { key: 'record', label: 'Start recording…', run: () => openRecorder(), off: !recordingSupported(),
                title: recordingSupported() ? 'Record this tab: slides, ink, widgets, your microphone' : 'Recording is not supported in this browser' },
        { sep: true },
        { key: 'end', label: 'End session', run: endSession, danger: true },
    ];
    for (const it of items) {
        if (it.sep) { menu.appendChild(document.createElement('hr')); continue; }
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.dataset.menu = it.key;
        if (it.danger) b.classList.add('is-danger');
        if (it.title) b.title = it.title;
        b.disabled = !!it.off;
        b.innerHTML = `${ICON[it.icon || it.key]}<span class="session-menu-label"></span>${it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}`;
        b.querySelector('.session-menu-label').textContent = it.label;
        b.addEventListener('click', () => { closeMenu(); it.run(); });
        menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)))}px`;
    anchor.setAttribute('aria-expanded', 'true');
    menu.querySelector('button:not(:disabled)')?.focus();
    setTimeout(() => {
        document.addEventListener('pointerdown', onAway, true);
        document.addEventListener('keydown', onKey, true);
    }, 0);
}

function onAway(e) { if (menu && !menu.contains(e.target) && !e.target.closest?.('#session-btn')) closeMenu(); }
function onKey(e) {
    if (!menu) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); document.getElementById('session-btn')?.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault(); e.stopPropagation();
    const all = [...menu.querySelectorAll('button:not(:disabled)')];
    const i = all.indexOf(document.activeElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
}

function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.getElementById('session-btn')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onAway, true);
    document.removeEventListener('keydown', onKey, true);
}

// Back to the start page. The presentation is kept in this browser as it is
// now (annotations and all), so "Last Session" there brings it back.
function endSession() {
    const go = async () => {
        if (isRecording()) await stopRecording();
        bus.emit('session:ending');
        await window.BeamerLastSession?.flush?.();
        window.location.href = '/';
    };
    if (!appState.zipFile && !isRecording()) { go(); return; }
    window.BeamerModal?.show({
        kind: 'warning',
        title: 'End this session?',
        message: `You’ll go back to the start page${isRecording() ? ' (the recording stops and is kept)' : ''}. `
            + '“Last Session” there picks up where you left off.',
        buttons: [{ label: 'Cancel', kind: 'cancel' }, { label: 'End session', kind: 'ok', onClick: go }],
    });
}
