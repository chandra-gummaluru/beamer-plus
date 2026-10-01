// Slide navigator drawer — a small hinge tab on the navigator's right edge
// slides the whole rail out of view to the left, and back again. Only the
// desktop left rail collapses; the bottom bar (split view, narrow screens)
// ignores it (CSS scopes every rule to that layout). The choice is a
// per-browser convenience, remembered in localStorage.

const KEY = 'beamer.navCollapsed';
const DUR = 260;   // keep in step with the transition in features/slides.css

let _hinge = null;

export function initNavDrawer() {
    _hinge = document.getElementById('nav-drawer-hinge');
    if (!_hinge) return;
    _hinge.addEventListener('click', () => setNavCollapsed(!isNavCollapsed()));

    let saved = false;
    try { saved = localStorage.getItem(KEY) === '1'; } catch (_) { /* storage blocked */ }
    if (saved) {
        // Restore without animating the stage on page load.
        document.body.classList.add('nav-drawer-instant');
        setNavCollapsed(true, { persist: false, settle: 0 });
        requestAnimationFrame(() => requestAnimationFrame(() =>
            document.body.classList.remove('nav-drawer-instant')));
    } else {
        _syncHinge();
    }
}

export function isNavCollapsed() {
    return document.body.classList.contains('nav-collapsed');
}

export function setNavCollapsed(collapsed, { persist = true, settle = DUR + 20 } = {}) {
    document.body.classList.toggle('nav-collapsed', !!collapsed);
    _syncHinge();
    if (persist) {
        try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (_) {}
    }
    // The stage just changed width: let the usual resize path re-fit the
    // slide, annotation canvas and overlays once the slide-out has finished.
    setTimeout(() => window.dispatchEvent(new Event('resize')), settle);
}

function _syncHinge() {
    if (!_hinge) return;
    const collapsed = isNavCollapsed();
    _hinge.setAttribute('aria-expanded', String(!collapsed));
    _hinge.title = collapsed ? 'Show slides' : 'Hide slides';
    _hinge.setAttribute('aria-label', _hinge.title);
}
