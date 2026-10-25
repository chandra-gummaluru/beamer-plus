/** Session helpers — presenter URLs are scoped under /s/{session_id}/. */

export function getSessionId() {
    if (window.BEAMER_SESSION_ID) return window.BEAMER_SESSION_ID;
    const m = window.location.pathname.match(/^\/s\/([^/]+)/);
    return m ? m[1] : null;
}

/** Base path for session-scoped API routes, e.g. `/s/ABC123`. */
function sessionPrefix() {
    const id = getSessionId();
    return id ? `/s/${id}` : '';
}

/** Prefix an API path with the current session scope. */
export function sessionUrl(path) {
    const prefix = sessionPrefix();
    if (!prefix) return path;
    return prefix + (path.startsWith('/') ? path : `/${path}`);
}

/** Widget iframe config fields shared by the presenter shell. */
export function widgetSessionConfig() {
    const id = getSessionId();
    const origin = window.location.origin;
    const base = id ? `${origin}/s/${id}` : origin;
    return {
        sessionId: id,
        socketUrl: origin,
        serverUrl: base,
        publicBaseUrl: base,
    };
}

export async function createSession() {
    const res = await fetch('/api/session/create', { method: 'POST' });
    if (!res.ok) throw new Error('Could not create session');
    return res.json();
}
