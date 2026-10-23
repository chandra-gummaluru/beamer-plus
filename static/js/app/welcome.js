// The start page: "New Session" starts an empty session; "Last Session"
// reopens the presentation you had open last, as you left it (kept in this
// browser by app/last-session.js). With nothing kept, Last Session is greyed out.

import { createSession, sessionExists } from './session.js';
import { lastSessionInfo } from './last-session.js';

const newBtn = document.getElementById('welcome-new-btn');
const lastBtn = document.getElementById('welcome-last-btn');
const lastLine = document.getElementById('welcome-last');
const statusEl = document.getElementById('welcome-status');

let last = null;

function setStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('is-error', isError);
}

function setBusy(on) {
    document.body.classList.toggle('is-busy', on);
    if (newBtn) newBtn.disabled = on;
    if (lastBtn) lastBtn.disabled = on || !last;
}

const go = (id, query = '') => { window.location.href = `/s/${id}/${query}`; };

// "Today, 10:41", "Yesterday, 16:05", or "Mon 20 Oct, 9:12".
function when(iso) {
    const d = new Date(iso);
    if (Number.isNaN(+d)) return '';
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const diff = Math.round((day - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
    if (diff === 0) return `today, ${t}`;
    if (diff === 1) return `yesterday, ${t}`;
    return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${t}`;
}

async function startNew() {
    setStatus('Creating session…');
    setBusy(true);
    try {
        const data = await createSession();
        go(data.session_id);
    } catch {
        setStatus('Could not create a session. Try again.', true);
        setBusy(false);
    }
}

// The last session's own code when the server still has it (audience links
// keep working), else a new session; either way the kept copy opens there.
async function reopenLast() {
    if (!last) return;
    setStatus('Reopening your last session…');
    setBusy(true);
    try {
        if (last.sessionId && await sessionExists(last.sessionId).catch(() => false)) {
            go(last.sessionId, '?resume=1');
            return;
        }
        const data = await createSession();
        go(data.session_id, '?resume=1');
    } catch {
        setStatus('Could not reopen it. Try again.', true);
        setBusy(false);
    }
}

async function init() {
    try { last = await lastSessionInfo(); } catch { last = null; }
    if (!last) return;
    lastBtn.disabled = false;
    const slide = Number(last.slide) || 0;
    const bits = [last.name, last.totalSlides ? `slide ${slide + 1} of ${last.totalSlides}` : null, when(last.savedAt)].filter(Boolean);
    lastBtn.title = `Reopen ${last.name || 'your last presentation'} where you left off`;
    if (lastLine) {
        lastLine.textContent = `Last: ${bits.join(' · ')}`;
        lastLine.hidden = false;
    }
}

newBtn?.addEventListener('click', startNew);
lastBtn?.addEventListener('click', reopenLast);

init();
