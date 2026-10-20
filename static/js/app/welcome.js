import { createSession, saveLastSession, sessionExists } from './session.js';
import { signedIn, startSignIn, consumeRedirect, signOut, user } from '../github/auth.js';

const ghBtn = document.getElementById('welcome-github-btn');
const ghLabel = document.getElementById('welcome-github-label');
const createBtn = document.getElementById('welcome-create-btn');
const keepRow = document.getElementById('welcome-keep-row');
const acct = document.getElementById('welcome-account');
const acctLogin = document.getElementById('welcome-login');
const acctAvatar = document.getElementById('welcome-avatar');
const keepBox = document.getElementById('welcome-keep');
const outBtn = document.getElementById('welcome-signout-btn');
const statusEl = document.getElementById('welcome-status');

function setStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('is-error', isError);
}

function setBusy(on) {
    for (const b of [ghBtn, createBtn]) if (b) b.disabled = on;
}

function goToSession(sessionId, { tour = false, github = false, guest = false } = {}) {
    saveLastSession(sessionId);
    const q = [tour && 'tour=1', github && 'gh=1', guest && 'guest=1'].filter(Boolean).join('&');
    window.location.href = `/s/${sessionId}/` + (q ? `?${q}` : '');
}

// Both buttons start a fresh session. Signed in with GitHub, the session
// opens and saves lectures there; as a guest, files come from and go to this
// computer. (The demo deck and its tour are offered inside the session.)
async function handleCreate({ tour = false, github = false, guest = false } = {}) {
    setStatus(tour ? 'Setting up the tour…' : 'Creating session…');
    setBusy(true);
    try {
        const data = await createSession();
        goToSession(data.session_id, { tour, github, guest });
    } catch {
        setStatus('Could not create a session. Try again.', true);
        setBusy(false);
    }
}

// Signed out: "Sign in with GitHub". Signed in: who you are above the
// buttons (with Sign out), and the GitHub button just starts a session.
function drawSignedIn(u = null) {
    const on = signedIn();
    if (ghLabel) ghLabel.textContent = on ? 'Start a session' : 'Sign in with GitHub';
    if (ghBtn) ghBtn.title = on ? 'Open and save your lectures in your GitHub course repository' : 'Sign in to open and save your lectures in your GitHub course repository';
    if (keepRow) keepRow.hidden = on;
    if (acct) acct.hidden = !on;
    if (acctLogin) acctLogin.textContent = u?.login || 'GitHub';
    if (acctAvatar) {
        acctAvatar.hidden = !u?.avatar_url;
        if (u?.avatar_url) acctAvatar.src = `${u.avatar_url}${u.avatar_url.includes('?') ? '&' : '?'}s=48`;
    }
}

async function init() {
    // Back from GitHub's sign-in page?
    const back = consumeRedirect();
    if (back?.error) setStatus(back.error, true);
    else if (back?.ok) {
        // Signed in from a presenter session (its sign-in had ended): go back to it.
        if (back.back && /^\/s\/[^/]+\/?$/.test(back.back)) {
            const id = back.back.split('/')[2];
            if (await sessionExists(id).catch(() => false)) { window.location.replace(back.back); return; }
        }
        setStatus('Signed in. Starting a session…');
        handleCreate({ github: true });
        return;
    }
    drawSignedIn();
    if (signedIn()) {
        user().then(u => drawSignedIn(u)).catch(e => {
            if (e.status === 401) { signOut(); drawSignedIn(); }
        });
    }
}

ghBtn?.addEventListener('click', async () => {
    if (signedIn()) { handleCreate({ github: true }); return; }
    setStatus('Going to GitHub…');
    try { await startSignIn({ keep: !!keepBox?.checked }); }
    catch (e) { setStatus(e.message, true); }
});
// A guest session ignores a GitHub sign-in this browser may hold.
createBtn?.addEventListener('click', () => handleCreate({ guest: signedIn() }));
outBtn?.addEventListener('click', () => { signOut(); drawSignedIn(); setStatus('Signed out of GitHub.'); });

init();
