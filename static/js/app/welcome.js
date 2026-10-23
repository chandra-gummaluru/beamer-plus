// The start page: "New Session" starts an empty session; "Try Demo" starts
// one with the demo presentation and its guided tour (main.js, ?tour=1).

import { createSession } from './session.js';

const newBtn = document.getElementById('welcome-new-btn');
const demoBtn = document.getElementById('welcome-demo-btn');
const statusEl = document.getElementById('welcome-status');

function setStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('is-error', isError);
}

function setBusy(on) {
    document.body.classList.toggle('is-busy', on);
    for (const b of [newBtn, demoBtn]) if (b) b.disabled = on;
}

async function start({ demo = false } = {}) {
    setStatus(demo ? 'Setting up the demo…' : 'Creating session…');
    setBusy(true);
    try {
        const data = await createSession();
        window.location.href = `/s/${data.session_id}/${demo ? '?tour=1' : ''}`;
    } catch {
        setStatus('Could not create a session. Try again.', true);
        setBusy(false);
    }
}

newBtn?.addEventListener('click', () => start());
demoBtn?.addEventListener('click', () => start({ demo: true }));
