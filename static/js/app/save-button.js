// Save (top-right) and the small menu beside it, plus the empty slide as the
// way to open a presentation.
//
//   Save            signed in with GitHub: saves to the deck's lecture (asks
//                   which lecture the first time, and asks about new
//                   recordings); as a guest: the download chooser.
//   ▾ menu          Open a presentation… · Download… · Demo presentation
//   Empty slide     click it to open a presentation (same as the menu item).
//   Ctrl/⌘+S        same as Save.

import { bus } from '../core/events.js';
import { openUpload } from './uploader.js';
import { openDownloadMenu } from '../editor/download-menu.js';
import { githubActive, saveToGitHub } from '../github/ui.js';

const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
    open: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
    download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    demo: svg('<path d="M7 4.5v15l12-7.5z"/>'),
};

let appState = null;
let menu = null;

export function initSaveButton(state) {
    appState = state;
    const save = document.getElementById('save-btn');
    const more = document.getElementById('save-more-btn');
    save?.addEventListener('click', () => doSave());
    more?.addEventListener('click', (e) => { e.stopPropagation(); menu ? closeMenu() : openMenu(more); });
    document.getElementById('stage-empty')?.addEventListener('click', () => openUpload());
    refreshTitles();
    bus.on('github:changed', refreshTitles);

    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's') return;
        e.preventDefault();
        if (!appState.zipFile || document.querySelector('.custom-modal-overlay, .widget-modal-overlay')) return;
        doSave();
    }, true);
}

function doSave() {
    if (!appState.zipFile) return;
    closeMenu();
    if (githubActive()) saveToGitHub();
    else openDownloadMenu();
}

function refreshTitles() {
    const save = document.getElementById('save-btn');
    if (save) save.title = githubActive() ? 'Save to GitHub (Ctrl+S)' : 'Save: download the presentation or notes (Ctrl+S)';
    const hint = document.getElementById('stage-empty-hint');
    if (hint) hint.textContent = githubActive()
        ? 'Click here to open a lecture from GitHub, or drop a PDF or Beamer+ ZIP anywhere.'
        : 'Click here to open a PDF or Beamer+ ZIP, or drop one anywhere.';
}

function openMenu(anchor) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'save-menu';
    menu.setAttribute('role', 'menu');
    const items = [
        { key: 'open', label: githubActive() ? 'Open a lecture…' : 'Open a presentation…', run: () => openUpload() },
        { key: 'download', label: 'Download…', run: () => openDownloadMenu(), off: !appState.zipFile },
        { sep: true },
        { key: 'demo', label: 'Demo presentation', run: () => bus.emit('demo:open') },
    ];
    for (const it of items) {
        if (it.sep) { menu.appendChild(document.createElement('hr')); continue; }
        if (it.off) continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.dataset.menu = it.key;
        b.innerHTML = `${ICON[it.key]}<span></span>`;
        b.querySelector('span').textContent = it.label;
        b.addEventListener('click', () => { closeMenu(); it.run(); });
        menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor.closest('.save-split')?.getBoundingClientRect() || anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)))}px`;
    anchor.setAttribute('aria-expanded', 'true');
    menu.querySelector('button')?.focus();
    setTimeout(() => {
        document.addEventListener('pointerdown', onAway, true);
        document.addEventListener('keydown', onKey, true);
    }, 0);
}

function onAway(e) { if (menu && !menu.contains(e.target) && !e.target.closest?.('#save-more-btn')) closeMenu(); }
function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }

function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.getElementById('save-more-btn')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onAway, true);
    document.removeEventListener('keydown', onKey, true);
}
