import { createSession, saveLastSession } from './session.js';

const createBtn = document.getElementById('welcome-create-btn');
const tourBtn = document.getElementById('welcome-tour-btn');
const statusEl = document.getElementById('welcome-status');

function setStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('is-error', isError);
}

function goToSession(sessionId, { tour = false } = {}) {
    saveLastSession(sessionId);
    window.location.href = `/s/${sessionId}/` + (tour ? '?tour=1' : '');
}

// Both buttons start a fresh session; the tour one also asks the presenter
// page to load the demo deck and run the guided tour.
async function handleCreate({ tour = false } = {}) {
    setStatus(tour ? 'Setting up the tour…' : 'Creating session…');
    if (createBtn) createBtn.disabled = true;
    if (tourBtn) tourBtn.disabled = true;
    try {
        const data = await createSession();
        goToSession(data.session_id, { tour });
    } catch {
        setStatus('Could not create a session. Try again.', true);
        if (createBtn) createBtn.disabled = false;
        if (tourBtn) tourBtn.disabled = false;
    }
}

createBtn?.addEventListener('click', () => handleCreate());
tourBtn?.addEventListener('click', () => handleCreate({ tour: true }));
