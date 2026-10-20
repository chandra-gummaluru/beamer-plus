// GitHub in the presenter: whether this session is signed in, who you are,
// and signing out. Opening and saving presentations (on GitHub, or in a
// folder when signed out) is library/ui.js; the session menu is
// app/account-menu.js.

import { bus } from '../core/events.js';
import { signedIn, user, signOut, schedule } from './auth.js';

let appState = null;
let active = false;     // signed in, and not a guest session
let me = null;          // { login, avatar_url }

export function initGitHub(state) {
    appState = state;
    bus.on('deck:loaded', () => { updateTitle(); bus.emit('github:changed'); });
    // A session started with "Continue as guest" stays a guest session, even
    // when this browser holds a GitHub sign-in.
    const params0 = new URLSearchParams(location.search);
    const guestKey = `beamer.github.guest:${location.pathname}`;
    try {
        if (params0.has('guest')) {
            sessionStorage.setItem(guestKey, '1');
            params0.delete('guest');
            const qs = params0.toString();
            history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
        }
        if (sessionStorage.getItem(guestKey)) return;
    } catch { /* storage blocked */ }
    if (!signedIn()) return;
    schedule();
    active = true;
    document.body.classList.add('gh-signed-in');
    bus.emit('github:changed');
    user().then(u => { me = u; bus.emit('github:changed'); }).catch(e => { if (e.status === 401) githubSignOut(); });

    // Just signed in from the start page: offer to open a presentation once the splash is gone.
    const params = new URLSearchParams(location.search);
    if (params.has('gh')) {
        params.delete('gh');
        const qs = params.toString();
        history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
        setTimeout(() => { if (!appState.zipFile && !document.querySelector('.custom-modal-overlay')) bus.emit('library:open'); }, 2100);
    }
}

export function updateTitle() {
    const t = appState?.ghTarget;
    document.title = t ? `${t.name} · Beamer+` : 'Beamer+';
}

/** True when this session uses GitHub (signed in, not a guest session). */
export const githubActive = () => active && signedIn();

/** Who's signed in ({ login, avatar_url }), or null. */
export async function githubUser() {
    if (!githubActive()) return null;
    if (!me) { try { me = await user(); } catch { return null; } }
    return me;
}

/** Sign out, staying in this session (the open deck stays open). */
export function githubSignOut() {
    signOut();
    document.body.classList.remove('gh-signed-in');
    if (appState?.ghTarget?.src?.startsWith('github:')) appState.ghTarget = null;
    active = false;
    me = null;
    updateTitle();
    bus.emit('github:changed');
    toast('Signed out of GitHub. Presentations now open from and save to a folder on this computer.');
}

let toastTimer = null;
export function toast(text) {
    let el = document.getElementById('recorder-toast');      // shares the recorder's toast styling
    if (!el) {
        el = document.createElement('div');
        el.id = 'recorder-toast';
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 5000);
}
