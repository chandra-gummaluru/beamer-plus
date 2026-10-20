// Top-right: the session menu, behind your account button (your GitHub name,
// or "Guest").
//
//   Signed in                                  Guest
//   ─────────                                  ─────
//   Signed in to GitHub as <login>.            Guest session.
//   Open a presentation…                       Open a presentation…
//   Edit presentation                          Edit presentation
//   Save presentation…                         Save presentation…
//   ───                                        ───
//   End session (signs you out too)            End session
//
// Open and Save use your GitHub repository when signed in; as a guest, Open
// is the file picker and Save picks a folder (library/ui.js). Edit and Save
// need an open presentation. "End session" goes back to the start page
// (which is also where you sign in).

import { bus } from '../core/events.js';
import { githubActive, githubUser } from '../github/ui.js';
import { openPresentation, savePresentation } from '../library/ui.js';
import { openUpload } from './uploader.js';
import { signOut } from '../github/auth.js';

const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
    gh: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
    save: svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
    person: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
    open: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
    edit: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
    out: svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l5-5-5-5M15 12H4"/>'),
    end: svg('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
    chevron: '<svg class="account-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>',
};

let appState = null;
let menu = null;
let me = null;          // the GitHub user, once known

export function initAccountMenu(state) {
    appState = state;
    const btn = document.getElementById('account-btn');
    btn?.addEventListener('click', (e) => { e.stopPropagation(); menu ? closeMenu() : openMenu(btn); });
    document.getElementById('stage-empty-open')?.addEventListener('click', () => openUpload());
    bus.on('github:changed', refresh);
    refresh();
}

// Edit mode's own button (top-right while editing) closes it; this opens it.
function toggleEdit() { document.getElementById('edit-mode-btn')?.click(); }


async function refresh() {
    me = githubActive() ? await githubUser() : null;
    const btn = document.getElementById('account-btn');
    if (!btn) return;
    const gh = githubActive();
    const pic = me?.avatar_url
        ? `<img class="account-avatar" src="${escAttr(me.avatar_url)}${me.avatar_url.includes('?') ? '&' : '?'}s=48" alt="">`
        : `<span class="account-mark">${gh ? ICON.gh : ICON.person}</span>`;
    btn.innerHTML = `${pic}<span class="account-name"></span>${ICON.chevron}`;
    btn.querySelector('.account-name').textContent = gh ? (me?.login || 'GitHub') : 'Guest';
    btn.title = gh ? `Signed in to GitHub as ${me?.login || '…'}` : 'Guest session';
    btn.classList.toggle('is-github', gh);
}

const escAttr = s => String(s).replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

function openMenu(anchor) {
    closeMenu();
    const gh = githubActive();
    const t = appState.ghTarget;
    menu = document.createElement('div');
    menu.className = 'account-menu';
    menu.setAttribute('role', 'menu');

    const head = document.createElement('div');
    head.className = 'account-menu-head';
    if (gh) {
        head.innerHTML = '<span>Signed in to GitHub as <b></b>.</span>';
        head.querySelector('b').textContent = me?.login || '…';
    } else {
        head.innerHTML = '<span>Guest session.</span>';
    }
    menu.appendChild(head);

    const deck = !!appState.zipFile;
    const editing = !!appState.editMode;
    const session = [
        { key: 'open', label: 'Open a presentation…', run: () => openPresentation() },
        { key: 'edit', label: editing ? 'Done editing' : 'Edit presentation', run: toggleEdit, off: !deck },
        { key: 'save', label: 'Save presentation…', run: () => savePresentation(), off: !deck },
    ];
    const items = gh ? [
        ...session,
        { sep: true },
        { key: 'end', label: 'End session', run: endSession, danger: true },
    ] : [
        ...session,
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
        if (it.strong) b.classList.add('is-strong');
        b.disabled = !!it.off;
        b.innerHTML = `${ICON[it.icon || it.key]}<span class="account-menu-label"></span>`;
        b.querySelector('.account-menu-label').textContent = it.label;
        b.addEventListener('click', () => { closeMenu(); it.run(); });
        menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.left)))}px`;
    anchor.setAttribute('aria-expanded', 'true');
    menu.querySelector('button:not(:disabled)')?.focus();
    setTimeout(() => {
        document.addEventListener('pointerdown', onAway, true);
        document.addEventListener('keydown', onKey, true);
    }, 0);
}

function onAway(e) { if (menu && !menu.contains(e.target) && !e.target.closest?.('#account-btn')) closeMenu(); }
function onKey(e) {
    if (!menu) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); document.getElementById('account-btn')?.focus(); return; }
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
    document.getElementById('account-btn')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onAway, true);
    document.removeEventListener('keydown', onKey, true);
}

// Leaving the page loses whatever isn't saved: ask first when a deck is open.
function confirmLeave(title, message, yes, go) {
    if (!appState.zipFile) { go(); return; }
    window.BeamerModal?.show({
        kind: 'warning', title, message,
        buttons: [{ label: 'Cancel', kind: 'cancel' }, { label: yes, kind: 'ok', onClick: go }],
    });
}

// Ending a session signs you out of GitHub too.
function endSession() {
    const gh = githubActive();
    confirmLeave('End this session?',
        `You’ll go back to the start page${gh ? ', signed out of GitHub' : ''}. Anything since your last save will be lost.`,
        'End session', () => { if (gh) signOut(); window.location.href = '/'; });
}
