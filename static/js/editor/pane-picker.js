// Picking a split view's two slides by clicking them in the slide list.
//
//   pickPanes({ onDone(left, right) })
//
// A bar across the top of the stage says which pane comes next; the next
// click on a thumbnail picks it and labels it Left, the one after that
// Right, and then onDone runs. Split views themselves
// can't be picked (a view of a view), and neither can the same slide twice.
// Esc or Cancel stops without changing anything.
//
// Clicks on thumbnails are caught in the capture phase, before the
// navigator's own handlers, so picking never navigates.

let _pick = null;   // { picks: [], onDone, bar, cleanup }

export function pickPanes({ onDone, onCancel } = {}) {
    cancelPick();
    const bar = document.createElement('div');
    bar.id = 'pane-picker';
    bar.setAttribute('role', 'status');
    bar.innerHTML = `
        <span class="pane-picker-steps" aria-hidden="true"><i></i><i></i></span>
        <span class="pane-picker-text"></span>
        <button type="button" class="btn pane-picker-cancel">Cancel</button>`;
    document.body.appendChild(bar);
    document.body.classList.add('picking-panes');

    const state = { picks: [], onDone, onCancel, bar };
    _pick = state;

    const onClick = (e) => {
        const item = e.target.closest?.('#slide-nav-slides .slide-nav-item[data-index]');
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        choose(Number(item.dataset.index), item);
    };
    const onKey = (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        cancelPick();
    };
    // Dragging a thumbnail (reordering) would start on pointerdown: not now.
    const onDown = (e) => {
        if (e.target.closest?.('#slide-nav-slides .slide-nav-item')) e.stopPropagation();
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('dragstart', onDown, true);
    bar.querySelector('.pane-picker-cancel').addEventListener('click', () => cancelPick());

    state.cleanup = () => {
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('dragstart', onDown, true);
        document.querySelectorAll('.slide-nav-item.is-pane-pick').forEach(el => {
            el.classList.remove('is-pane-pick');
            delete el.dataset.pane;
        });
        document.body.classList.remove('picking-panes');
        bar.remove();
    };
    sync();
}

export function cancelPick() {
    if (!_pick) return;
    const p = _pick;
    _pick = null;
    p.cleanup();
    p.onCancel?.();
}

function choose(i, item) {
    const p = _pick;
    const obj = window.beamerState?.slideStructure?.[i];
    // Not a split view, and not the slide already picked for the left.
    if (!obj || obj.type === 'view' || p.picks.includes(i)) {
        item.classList.remove('is-pane-refused');
        void item.offsetWidth;            // restart the shake
        item.classList.add('is-pane-refused');
        return;
    }
    p.picks.push(i);
    item.classList.add('is-pane-pick');
    item.dataset.pane = p.picks.length === 1 ? 'Left' : 'Right';
    if (p.picks.length < 2) { sync(); return; }
    const [left, right] = p.picks;
    // Let the Right label show for a moment before the split opens.
    setTimeout(() => {
        if (_pick !== p) return;
        _pick = null;
        p.cleanup();
        p.onDone?.(left, right);
    }, 220);
}

function sync() {
    const p = _pick;
    if (!p) return;
    const n = p.picks.length;
    p.bar.querySelector('.pane-picker-text').innerHTML = n === 0
        ? '<strong>Left Slide</strong><span>Click it in the slide list.</span>'
        : '<strong>Right Slide</strong><span>Now click the other one.</span>';
    p.bar.querySelectorAll('.pane-picker-steps i').forEach((dot, k) => dot.classList.toggle('is-done', k < n));
}
