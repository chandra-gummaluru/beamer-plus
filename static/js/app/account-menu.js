// Top-right, as in Lectern: the account button and Save.
//
//   Account (signed in)               Account (signed out: "Connect GitHub")
//   ───────────────────               ──────────────────────────────────────
//   login · repository · lecture      Sign in with GitHub
//   Open a lecture…                   Open a presentation…
//   Demo presentation                 Demo presentation
//   ───                               ───
//   Change repository                 End session
//   Sign out
//   End session
//
//   Save   signed in: a dialog asking what to save to GitHub (the deck, the
//          notes PDF, recordings); as a guest: what to download.
//   Ctrl/⌘+S  signed in: a quick save to GitHub; as a guest: the same as Save.
//
// "End session" goes back to the start page. Opening a presentation is also
// a click on the empty slide (signed in, from GitHub only).

import { bus } from '../core/events.js';
import { openUpload } from './uploader.js';
import { openDownloadMenu } from '../editor/download-menu.js';
import { githubActive, saveToGitHub, openGitHubSave, githubUser, githubSignOut, githubRepoLabel, openRepoChooser } from '../github/ui.js';
import { startSignIn } from '../github/auth.js';

const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
    gh: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
    open: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>'),
    demo: svg('<path d="M7 4.5v15l12-7.5z"/>'),
    repo: svg('<path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v16H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M5 20.5A2.5 2.5 0 0 0 7.5 23H19v-5"/>'),
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
    document.getElementById('save-btn')?.addEventListener('click', () => save({ ask: true }));
    document.getElementById('stage-empty')?.addEventListener('click', () => openUpload());
    bus.on('github:changed', refresh);
    bus.on('deck:loaded', refreshSave);
    refresh();

    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's') return;
        e.preventDefault();
        if (!appState.zipFile || document.querySelector('.custom-modal-overlay, .widget-modal-overlay')) return;
        save({ ask: false });
    }, true);
}

function save({ ask }) {
    if (!appState.zipFile) return;
    closeMenu();
    if (!githubActive()) openDownloadMenu();
    else if (ask) openGitHubSave();
    else saveToGitHub();
}

function refreshSave() {
    const s = document.getElementById('save-btn');
    if (!s) return;
    s.disabled = !appState.zipFile;
    s.title = githubActive() ? 'Save to GitHub (Ctrl+S saves straight away)' : 'Save to this computer (Ctrl+S)';
}

async function refresh() {
    refreshSave();
    me = githubActive() ? await githubUser() : null;
    const btn = document.getElementById('account-btn');
    if (!btn) return;
    const gh = githubActive();
    const pic = me?.avatar_url
        ? `<img class="account-avatar" src="${escAttr(me.avatar_url)}${me.avatar_url.includes('?') ? '&' : '?'}s=48" alt="">`
        : `<span class="account-mark">${ICON.gh}</span>`;
    btn.innerHTML = `${pic}<span class="account-name"></span>${ICON.chevron}`;
    btn.querySelector('.account-name').textContent = gh ? (me?.login || 'GitHub') : 'Connect GitHub';
    btn.title = gh ? `Signed in to GitHub as ${me?.login || '…'}` : 'Not signed in: connect GitHub to open and save your course lectures';
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
        head.innerHTML = `<b></b><span class="account-menu-sub"></span>${t ? '<span class="account-menu-sub account-menu-lecture"></span>' : ''}`;
        head.querySelector('b').textContent = me?.login || 'GitHub';
        head.querySelector('.account-menu-sub').textContent = githubRepoLabel() || 'No repository chosen yet';
        if (t) head.querySelector('.account-menu-lecture').textContent = `${t.c}/${t.t} › ${t.lecture}`;
    } else {
        head.innerHTML = '<b>Not signed in</b><span class="account-menu-sub">Files open from and save to this computer.</span>';
    }
    menu.appendChild(head);

    const items = gh ? [
        { key: 'open', label: 'Open a lecture…', run: () => openUpload() },
        { key: 'demo', label: 'Demo presentation', run: () => bus.emit('demo:open') },
        { sep: true },
        { key: 'repo', label: 'Change repository', run: () => openRepoChooser() },
        { key: 'out', label: 'Sign out', run: () => githubSignOut() },
        { key: 'end', label: 'End session', run: endSession, danger: true },
    ] : [
        { key: 'in', label: 'Sign in with GitHub', icon: 'gh', run: signIn, strong: true },
        { key: 'open', label: 'Open a presentation…', run: () => openUpload() },
        { key: 'demo', label: 'Demo presentation', run: () => bus.emit('demo:open') },
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
    menu.querySelector('button')?.focus();
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
    const all = [...menu.querySelectorAll('button')];
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

function endSession() {
    confirmLeave('End this session?',
        githubActive() ? 'You’ll go back to the start page. Anything since your last save to GitHub will be lost.'
                       : 'You’ll go back to the start page. Anything you haven’t saved to this computer will be lost.',
        'End session', () => { window.location.href = '/'; });
}

function signIn() {
    confirmLeave('Connect GitHub?',
        'Signing in starts a new session, so this presentation closes. Save anything you want to keep to this computer first.',
        'Sign in', () => startSignIn({}).catch(e => window.BeamerModal?.show({ kind: 'error', title: 'Sign-in', message: e.message })));
}
