// Sign in with GitHub (a GitHub App's user login) and the authenticated
// fetch every other GitHub module goes through.
//
// Tokens stay in this browser: sessionStorage by default (a lecture-room
// computer forgets them when the tab closes), localStorage when "Keep me
// signed in" was ticked. Only the one-time sign-in code and the 8-hourly
// refreshes pass through Beamer+'s server (server/github.py).
//
// Using Beamer+ as a guest is simply not having a token: nothing here runs.

const KEY = 'beamer.github';                // { access_token, refresh_token, expires_at, refresh_expires_at }
const STATE = 'beamer.github.state';
const REMEMBER = 'beamer.github.remember';
const RETURN = 'beamer.github.return';      // where to go once the sign-in comes back

let tok = null;
let remember = false;
const listeners = new Set();

export class GhError extends Error {
    constructor(status, msg) { super(msg); this.status = status; }
}

function read() {
    try {
        const l = localStorage.getItem(KEY), s = sessionStorage.getItem(KEY);
        remember = !!l;
        tok = JSON.parse(l || s || 'null');
    } catch { tok = null; }
}
function write() {
    try {
        localStorage.removeItem(KEY); sessionStorage.removeItem(KEY);
        if (tok) (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(tok));
    } catch { /* storage blocked: the sign-in lasts as long as this page */ }
}
function fromResponse(d) {
    const now = Date.now();
    return {
        access_token: d.access_token,
        refresh_token: d.refresh_token || tok?.refresh_token || '',
        expires_at: d.expires_in ? now + Number(d.expires_in) * 1000 : 0,          // 0: doesn't expire
        refresh_expires_at: d.refresh_token_expires_in ? now + Number(d.refresh_token_expires_in) * 1000 : 0,
    };
}

export const signedIn = () => { if (!tok) read(); return !!tok?.access_token; };
export const onToken = fn => { listeners.add(fn); return () => listeners.delete(fn); };

/** The sign-in coming back from GitHub: tokens (or an error) in the URL's #fragment. */
export function consumeRedirect() {
    const h = location.hash.slice(1);
    if (!/(^|&)gh_/.test(h)) return null;
    const p = new URLSearchParams(h);
    history.replaceState(null, '', location.pathname + location.search);
    let expected = '';
    let back = '';
    try {
        expected = sessionStorage.getItem(STATE) || '';
        remember = sessionStorage.getItem(REMEMBER) === '1';
        back = sessionStorage.getItem(RETURN) || '';
        sessionStorage.removeItem(STATE); sessionStorage.removeItem(RETURN);
    } catch { /* ignore */ }
    if (!expected || p.get('state') !== expected) return { error: "That sign-in didn't start here. Please try again." };
    if (p.get('gh_error')) return { error: p.get('gh_error'), back };
    tok = fromResponse({
        access_token: p.get('gh_access_token'), refresh_token: p.get('gh_refresh_token'),
        expires_in: p.get('gh_expires_in'), refresh_token_expires_in: p.get('gh_refresh_token_expires_in'),
    });
    write();
    return { ok: true, back };
}

/** Off to GitHub to sign in. It comes back to /api/github/callback, then to the welcome page,
 *  which returns to `back` (a presenter session's address) when one is given. */
export async function startSignIn({ keep = false, back = '' } = {}) {
    let cfg;
    try { cfg = await (await fetch('/api/github/config')).json(); }
    catch { throw new GhError(0, "Couldn't reach the Beamer+ server."); }
    if (!cfg.configured) {
        throw new GhError(0, "Sign-in with GitHub isn't set up on this server yet (see the README: BEAMER_GH_CLIENT_ID and BEAMER_GH_CLIENT_SECRET).");
    }
    const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    try {
        sessionStorage.setItem(STATE, state);
        sessionStorage.setItem(REMEMBER, keep ? '1' : '0');
        if (back) sessionStorage.setItem(RETURN, back); else sessionStorage.removeItem(RETURN);
    } catch { /* ignore */ }
    const q = new URLSearchParams({ client_id: cfg.client_id, redirect_uri: cfg.redirect_uri, state });
    location.assign(`${cfg.authorize_url}?${q}`);
}

export function signOut() {
    tok = null; write();
    try { localStorage.removeItem('beamer.github.user'); } catch { /* ignore */ }
}

/** The app's public settings (for the "Give Beamer+ access" link). */
let cfgPromise = null;
export function appConfig() {
    if (!cfgPromise) cfgPromise = fetch('/api/github/config').then(r => r.json()).catch(() => ({}));
    return cfgPromise;
}

// Sign-ins last 8 hours: swap the refresh token for a new one a little before then.
let refreshing = null, timer = 0;
async function refresh() {
    if (!tok?.refresh_token) throw new GhError(401, 'Your GitHub sign-in has ended. Please sign in again.');
    if (!refreshing) refreshing = (async () => {
        let res, data = {};
        try {
            res = await fetch('/api/github/refresh', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: tok.refresh_token }),
            });
            data = await res.json();
        } catch { throw new GhError(0, "Couldn't reach the Beamer+ server to renew your sign-in."); }
        if (!res.ok || !data.access_token) {
            if (res.status === 401) { signOut(); throw new GhError(401, data.error || 'Your GitHub sign-in has ended. Please sign in again.'); }
            throw new GhError(res.status, data.error || "Couldn't renew your GitHub sign-in.");
        }
        tok = fromResponse(data); write(); schedule();
        listeners.forEach(fn => { try { fn(tok.access_token); } catch (e) { console.error(e); } });
    })().finally(() => { refreshing = null; });
    return refreshing;
}
export function schedule() {
    clearTimeout(timer);
    if (!tok?.expires_at) return;
    const wait = tok.expires_at - Date.now() - 10 * 60 * 1000;     // ten minutes early
    timer = setTimeout(() => refresh().catch(e => console.warn('[github] refresh:', e.message)), Math.max(wait, 5000));
}
async function fresh() {
    if (!tok) read();
    if (!tok) throw new GhError(401, 'Please sign in with GitHub.');
    if (tok.expires_at && tok.expires_at - Date.now() < 2 * 60 * 1000) await refresh();
}
// A laptop that slept through the timer catches up when it wakes.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && tok?.expires_at) fresh().catch(() => {});
});

function message(status, detail) {
    return {
        401: "GitHub didn't accept the sign-in. Please sign in again.",
        403: /rate limit/i.test(detail) ? "GitHub's rate limit was reached. Wait a few minutes and try again."
            : `GitHub refused this: ${detail || "Beamer+ doesn't have permission"}.`,
        404: 'Not found on GitHub (or Beamer+ isn’t allowed to see it).',
        409: `GitHub said: ${detail || 'conflict'}`,
        413: 'That file is too large for GitHub.',
        422: `GitHub said: ${detail || 'it couldn’t do that'}`,
    }[status] || `GitHub said: ${detail || status}`;
}

/** A GitHub REST call. `raw: true` returns the response body as an ArrayBuffer. */
export async function api(path, opts = {}, retried = false) {
    await fresh();
    const { raw, ...init } = opts;
    let res;
    try {
        res = await fetch(`https://api.github.com${path}`, {
            ...init,
            headers: {
                Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
                Authorization: `Bearer ${tok.access_token}`,
                'X-GitHub-Api-Version': '2022-11-28',
                ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            },
        });
    } catch { throw new GhError(0, "Couldn't reach GitHub. Check your internet connection."); }
    if (res.status === 401 && !retried && tok.refresh_token) { await refresh(); return api(path, opts, true); }
    if (res.ok) {
        if (raw) return res.arrayBuffer();
        return res.status === 204 ? null : res.json();
    }
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* not JSON */ }
    throw new GhError(res.status, message(res.status, detail));
}

export const user = () => api('/user');
