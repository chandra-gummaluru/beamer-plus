// Keyboard shortcuts — the default key for each tool. Bindings someone saved
// under 'beamer-shortcuts' (by an earlier version's settings panel) still
// override these.
//
// There is no theme control: Beamer+ is a light-mode app. A projector washes
// out a dark palette, so the choice was never worth the switch.

const DEFAULT_SHORTCUTS = {
    hand:             'h',
    eraser:           'e',
    spotlight:        's',
    magnify:          'm',
    bookmark:         'b',
    clearAnnotations: 'c',
    splitView:        'v',
    focusMode:        'f',
    pen1:             '1',
    pen2:             '2',
};

export function loadShortcuts() {
    try { return { ...DEFAULT_SHORTCUTS, ...JSON.parse(localStorage.getItem('beamer-shortcuts') || '{}') }; }
    catch { return { ...DEFAULT_SHORTCUTS }; }
}
