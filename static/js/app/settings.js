// Settings — theme and rebindable keyboard shortcuts. Exposes a settings panel
// (built into the combined Help & Settings modal) and owns the preferences
// persisted in localStorage.
//
// There is no "install as app" control: Beamer+ caches nothing, and a browser
// will only offer to install a site that registers a service worker with a
// fetch handler. The button could therefore never do anything.

import { getSessionId } from './session.js';

/* ─── keyboard shortcut bindings ──────────────────────────────── */
export const DEFAULT_SHORTCUTS = {
    hand:             'h',
    eraser:           'e',
    spotlight:        's',
    bookmark:         'b',
    clearAnnotations: 'c',
    splitView:        'v',
    focusMode:        'f',
    pen1:             '1',
    pen2:             '2',
    pen3:             '3',
    pen4:             '4',
    pen5:             '5',
};

const SHORTCUT_LABELS = {
    hand:             'Hand / pointer',
    eraser:           'Eraser',
    spotlight:        'Spotlight',
    bookmark:         'Bookmark slide',
    clearAnnotations: 'Clear annotations',
    splitView:        'Split view',
    focusMode:        'Focus mode',
    pen1:             'Pen slot 1',
    pen2:             'Pen slot 2',
    pen3:             'Pen slot 3',
    pen4:             'Pen slot 4',
    pen5:             'Pen slot 5',
};

export function loadShortcuts() {
    try { return { ...DEFAULT_SHORTCUTS, ...JSON.parse(localStorage.getItem('beamer-shortcuts') || '{}') }; }
    catch { return { ...DEFAULT_SHORTCUTS }; }
}

export function saveShortcuts(sc) {
    localStorage.setItem('beamer-shortcuts', JSON.stringify(sc));
}

/* ─── theme ───────────────────────────────────────────────────── */
export function applyTheme(theme) {
    localStorage.setItem('beamer-theme', theme);
    const html = document.documentElement;
    if (theme === 'dark') {
        html.setAttribute('data-theme', 'dark');
    } else {
        // 'light' or any legacy value (e.g. 'system') → light
        html.removeAttribute('data-theme');
    }
}

const NON_BINDABLE = new Set([
    'Tab','Enter','Backspace','Delete','Escape',
    'ArrowLeft','ArrowRight','ArrowUp','ArrowDown','PageUp','PageDown','Home','End',
    'Control','Meta','Alt','Shift','CapsLock',
    'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
]);

function _hasShortcutConflicts(sc) {
    const vals = Object.values(sc).filter(v => v);
    return vals.length !== new Set(vals).size;
}

function _updateShortcutConflicts(scGrid, sc, hintEl) {
    const counts = {};
    for (const key of Object.values(sc)) {
        if (key) counts[key] = (counts[key] || 0) + 1;
    }
    const hasConflicts = Object.values(counts).some(c => c > 1);
    scGrid.querySelectorAll('.shortcut-capture').forEach(inp => {
        const key = sc[inp.dataset.action];
        inp.classList.toggle('is-error', !!(key && counts[key] > 1));
    });
    if (hintEl) {
        if (hasConflicts) {
            hintEl.textContent = 'Duplicate keys: resolve all conflicts to close.';
            hintEl.classList.add('is-error');
        } else {
            hintEl.textContent = 'Click a key to rebind it.';
            hintEl.classList.remove('is-error');
        }
    }
}

const _SUN_SVG  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/></svg>`;
const _MOON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

/* ─── settings panel (theme + editable shortcuts, applied live) ──
   Built into the combined Help & Settings modal. Changes persist as they are
   made (theme on click, shortcuts on each rebind), so there is no Save/Cancel —
   the caller only needs to block closing while there are shortcut conflicts,
   via the returned hasConflicts(). */
export function buildSettingsPanel() {
    const sc = loadShortcuts();

    const body = document.createElement('div');
    body.className = 'settings-grid';

    // ── Session code ───────────────────────────────────────────
    const sessionId = getSessionId();
    if (sessionId) {
        const sessionLabel = document.createElement('div');
        sessionLabel.className = 'settings-label settings-label-center';
        sessionLabel.textContent = 'Session Code';
        body.appendChild(sessionLabel);

        const codeBtn = document.createElement('button');
        codeBtn.className = 'settings-session-code';
        codeBtn.type = 'button';
        codeBtn.textContent = sessionId;
        codeBtn.title = 'Click to copy — share with co-presenters';
        codeBtn.addEventListener('click', async () => {
            try { await navigator.clipboard?.writeText(sessionId); } catch { /* ignore */ }
            const prev = codeBtn.textContent;
            codeBtn.classList.add('is-copied');
            codeBtn.textContent = 'Copied';
            setTimeout(() => { codeBtn.textContent = prev; codeBtn.classList.remove('is-copied'); }, 1200);
        });
        body.appendChild(codeBtn);
    }

    // ── Theme ──────────────────────────────────────────────────
    const themeSection = document.createElement('div');
    themeSection.className = 'settings-section';
    const rawTheme = localStorage.getItem('beamer-theme') || 'light';
    // Treat legacy 'system' as 'light'
    const savedTheme = (rawTheme === 'dark') ? 'dark' : 'light';
    const themeLabel = document.createElement('div');
    themeLabel.className = 'settings-label settings-label-center';
    themeLabel.textContent = 'Theme';
    themeSection.appendChild(themeLabel);

    const themeRow = document.createElement('div');
    themeRow.className = 'settings-theme-row';
    [{ value: 'light', label: 'Light', svg: _SUN_SVG }, { value: 'dark', label: 'Dark', svg: _MOON_SVG }].forEach(({ value, label, svg }) => {
        const btn = document.createElement('button');
        btn.className = 'btn settings-theme-btn' + (savedTheme === value ? ' btn_selected' : '');
        btn.title = label;
        btn.innerHTML = svg;
        btn.addEventListener('click', () => {
            applyTheme(value);
            themeRow.querySelectorAll('.btn').forEach(b => b.classList.remove('btn_selected'));
            btn.classList.add('btn_selected');
        });
        themeRow.appendChild(btn);
    });
    themeSection.appendChild(themeRow);
    body.appendChild(themeSection);

    // ── Keyboard Shortcuts ─────────────────────────────────────
    const scSection = document.createElement('div');
    scSection.className = 'settings-section';

    const scLabel = document.createElement('div');
    scLabel.className = 'settings-label settings-label-center';
    scLabel.textContent = 'Keyboard Shortcuts';
    scSection.appendChild(scLabel);

    // Hint + reset on one line
    const scHintRow = document.createElement('div');
    scHintRow.className = 'settings-hint-row';

    const scHint = document.createElement('p');
    scHint.className = 'settings-shortcut-hint';
    scHint.textContent = 'Click a key to rebind it.';
    scHintRow.appendChild(scHint);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'settings-shortcuts-reset-btn';
    resetBtn.textContent = 'Reset defaults';
    resetBtn.addEventListener('click', () => {
        Object.assign(sc, DEFAULT_SHORTCUTS);
        saveShortcuts(sc);
        scGrid.querySelectorAll('.shortcut-capture').forEach((inp, i) => {
            inp.value = DEFAULT_SHORTCUTS[Object.keys(SHORTCUT_LABELS)[i]] ?? '';
        });
        _updateShortcutConflicts(scGrid, sc, scHint);
    });
    scHintRow.appendChild(resetBtn);
    scSection.appendChild(scHintRow);

    const scGrid = document.createElement('div');
    scGrid.className = 'settings-shortcuts-grid';

    Object.entries(SHORTCUT_LABELS).forEach(([action, labelText]) => {
        const labelEl = document.createElement('span');
        labelEl.className = 'settings-shortcut-label';
        labelEl.textContent = labelText;
        scGrid.appendChild(labelEl);

        const input = document.createElement('input');
        input.type = 'text';
        input.readOnly = true;
        input.className = 'shortcut-capture';
        input.dataset.action = action;
        input.value = sc[action] ?? DEFAULT_SHORTCUTS[action] ?? '';
        input.title = 'Click to rebind';

        input.addEventListener('focus', () => {
            input.dataset.prev = input.value;
            input.value = '';
            input.placeholder = '…';
            input.classList.add('capturing');
        });
        input.addEventListener('keydown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { input.value = input.dataset.prev ?? ''; input.blur(); return; }
            if (e.ctrlKey || e.metaKey || e.altKey) { input.blur(); return; }
            if (NON_BINDABLE.has(e.key)) { input.blur(); return; }
            input.value = e.key;
            sc[action] = e.key;
            saveShortcuts(sc);
            _updateShortcutConflicts(scGrid, sc, scHint);
            input.blur();
        });
        input.addEventListener('blur', () => {
            input.classList.remove('capturing');
            input.placeholder = '';
            if (!input.value) input.value = input.dataset.prev ?? '';
        });

        scGrid.appendChild(input);
    });
    scSection.appendChild(scGrid);

    body.appendChild(scSection);

    return { node: body, hasConflicts: () => _hasShortcutConflicts(sc) };
}

/* ─── init ────────────────────────────────────────────────────── */
export function initSettings() {
    // The settings UI now lives inside the combined Help & Settings modal
    // (see help.js); here we only need to apply the persisted theme on load.
    applyTheme(localStorage.getItem('beamer-theme') || 'light');
}
