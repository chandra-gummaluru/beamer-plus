// Dropdowns — every <select> in the editor panel (and the widget settings
// sheet) opens our own menu instead of the browser's, so it looks the same
// on every computer and an option can carry a short line under its name
// (<option data-desc="…">, or "d" on a schema option).
//
//   • click, Enter, Space or ↓ on the box opens the menu
//   • ↑ / ↓, Home / End move; typing a letter jumps to an option
//   • Enter or a click chooses; Esc, Tab or a click elsewhere closes
//
// The <select> stays the real control: it's hidden, not replaced, so code
// that reads .value or listens for input / change on it carries on as is.
// Choosing fires `input` then `change`, both bubbling. Setting .value or
// .selectedIndex from code updates the box too, and a MutationObserver
// upgrades any select that lands in the panel later (panels rebuild freely).

const SEL = 'select.field';

const CHEVRON = '<svg class="editor-dd-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>';
const CHECK   = '<svg class="editor-dd-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';

let _menuSeq = 0;

/** Upgrade the selects already in `root`, and any added to it later. */
export function initDropdowns(root = document.getElementById('editor-panel')) {
    if (!root) return;
    enhanceSelects(root);
    new MutationObserver(muts => {
        for (const m of muts) for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.matches?.(SEL)) enhance(n);
            n.querySelectorAll?.(SEL).forEach(enhance);
        }
    }).observe(root, { childList: true, subtree: true });
}

/** Upgrade the selects in one subtree now (a form built off-page). */
export function enhanceSelects(root) {
    root?.querySelectorAll?.(SEL).forEach(enhance);
}

const PROTO = HTMLSelectElement.prototype;
const VALUE = Object.getOwnPropertyDescriptor(PROTO, 'value');
const INDEX = Object.getOwnPropertyDescriptor(PROTO, 'selectedIndex');

function enhance(select) {
    if (select.dataset.dd || select.multiple) return;
    // A select a segmented control or size picker stands in for stays hidden
    // and keeps no box of its own.
    if (select.hidden && select.nextElementSibling?.matches?.('.wf-seg, .wf-sizes')) return;
    select.dataset.dd = '1';

    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'editor-dd';
    box.setAttribute('aria-haspopup', 'listbox');
    box.setAttribute('aria-expanded', 'false');
    box.innerHTML = `<span class="editor-dd-value"></span>${CHEVRON}`;
    const label = select.closest('.editor-prop-row')?.querySelector('.editor-prop-label');
    if (label?.textContent) box.setAttribute('aria-label', label.textContent.trim());
    select.classList.add('editor-dd-native');
    select.tabIndex = -1;
    select.after(box);

    const sync = () => {
        const o = select.options[select.selectedIndex];
        box.querySelector('.editor-dd-value').textContent = o ? o.textContent : '';
        box.disabled = select.disabled;
        box.hidden = select.hidden;
    };
    // Code that sets the value directly (a panel refreshing itself) moves
    // the box too: no event fires for that.
    Object.defineProperty(select, 'value', {
        configurable: true,
        get() { return VALUE.get.call(this); },
        set(v) { VALUE.set.call(this, v); sync(); },
    });
    Object.defineProperty(select, 'selectedIndex', {
        configurable: true,
        get() { return INDEX.get.call(this); },
        set(v) { INDEX.set.call(this, v); sync(); },
    });
    select.addEventListener('change', sync);
    new MutationObserver(sync).observe(select, { attributes: true, attributeFilter: ['disabled', 'hidden'], childList: true, subtree: true });

    box.addEventListener('click', () => (_open?.select === select ? close() : open(select, box)));
    box.addEventListener('keydown', (e) => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
            e.preventDefault();
            open(select, box);
        }
    });
    sync();
}

/* ─── the menu ──────────────────────────────────────────────────── */

let _open = null;   // { select, box, menu, active, typed, typedAt }

function open(select, box) {
    close();
    if (select.disabled) return;
    const menu = document.createElement('div');
    menu.className = 'editor-dd-menu';
    menu.setAttribute('role', 'listbox');
    menu.id = `editor-dd-menu-${++_menuSeq}`;
    if (box.getAttribute('aria-label')) menu.setAttribute('aria-label', box.getAttribute('aria-label'));

    Array.from(select.options).forEach((o, i) => {
        if (o.hidden) return;
        const row = document.createElement('div');
        row.className = 'editor-dd-opt';
        row.setAttribute('role', 'option');
        row.id = `${menu.id}-${i}`;
        row.dataset.i = i;
        const selected = i === select.selectedIndex;
        row.setAttribute('aria-selected', String(selected));
        if (o.disabled) row.setAttribute('aria-disabled', 'true');
        const text = document.createElement('span');
        text.className = 'editor-dd-text';
        const name = document.createElement('span');
        name.className = 'editor-dd-name';
        name.textContent = o.textContent;
        text.appendChild(name);
        if (o.dataset.desc) {
            const d = document.createElement('span');
            d.className = 'editor-dd-desc';
            d.textContent = o.dataset.desc;
            text.appendChild(d);
        }
        row.appendChild(text);
        if (selected) row.insertAdjacentHTML('beforeend', CHECK);
        row.addEventListener('mousemove', () => setActive(i));
        row.addEventListener('click', () => { if (!o.disabled) choose(i); });
        menu.appendChild(row);
    });

    document.body.appendChild(menu);
    _open = { select, box, menu, active: -1, typed: '', typedAt: 0 };
    place();
    box.setAttribute('aria-expanded', 'true');
    box.setAttribute('aria-controls', menu.id);
    box.classList.add('is-open');
    setActive(select.selectedIndex >= 0 ? select.selectedIndex : firstEnabled(1, -1), true);

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
}

// Below the box, as wide as it; above it instead when there's no room.
function place() {
    const { box, menu } = _open;
    const r = box.getBoundingClientRect();
    const gap = 4, margin = 8;
    menu.style.minWidth = `${Math.max(r.width, 180)}px`;
    menu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - margin - Math.max(r.width, 180)))}px`;
    const h = menu.offsetHeight;
    const below = window.innerHeight - r.bottom - margin;
    const top = (h <= below || below >= r.top - margin) ? r.bottom + gap : r.top - gap - h;
    menu.style.top = `${Math.round(Math.max(margin, top))}px`;
    menu.style.maxHeight = `${Math.max(140, (top > r.top ? below : r.top - margin) - gap)}px`;
}

function close() {
    if (!_open) return;
    const { box, menu } = _open;
    menu.remove();
    box.setAttribute('aria-expanded', 'false');
    box.removeAttribute('aria-controls');
    box.removeAttribute('aria-activedescendant');
    box.classList.remove('is-open');
    _open = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
}

function choose(i) {
    const { select, box } = _open;
    close();
    if (select.selectedIndex !== i) {
        select.selectedIndex = i;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    box.focus();
}

function setActive(i, scroll = false) {
    const { menu, box } = _open;
    if (i < 0) return;
    _open.active = i;
    let el = null;
    menu.querySelectorAll('.editor-dd-opt').forEach(row => {
        const on = Number(row.dataset.i) === i;
        row.classList.toggle('is-active', on);
        if (on) el = row;
    });
    if (el) {
        box.setAttribute('aria-activedescendant', el.id);
        if (scroll) el.scrollIntoView({ block: 'nearest' });
    }
}

// The next option that can be chosen, from `from` in direction `dir`.
function firstEnabled(dir, from) {
    const opts = Array.from(_open.select.options);
    for (let i = from + dir; i >= 0 && i < opts.length; i += dir) {
        if (!opts[i].disabled && !opts[i].hidden) return i;
    }
    return -1;
}

function onKey(e) {
    if (!_open) return;
    const n = _open.select.options.length;
    const go = (i) => { if (i >= 0) setActive(i, true); };
    switch (e.key) {
        case 'ArrowDown': go(firstEnabled(1, _open.active)); break;
        case 'ArrowUp':   go(firstEnabled(-1, _open.active)); break;
        case 'Home':      go(firstEnabled(1, -1)); break;
        case 'End':       go(firstEnabled(-1, n)); break;
        case 'Enter':
        case ' ':         if (_open.active >= 0) choose(_open.active); break;
        case 'Escape':    { const b = _open.box; close(); b.focus(); break; }
        case 'Tab':       close(); return;   // let focus move on
        default: {
            // Type to find: the first option starting with what's been typed.
            if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
            const now = Date.now();
            _open.typed = (now - _open.typedAt < 700 ? _open.typed : '') + e.key.toLowerCase();
            _open.typedAt = now;
            const opts = Array.from(_open.select.options);
            const hit = opts.findIndex(o => !o.disabled && !o.hidden && o.textContent.trim().toLowerCase().startsWith(_open.typed));
            go(hit);
        }
    }
    // The menu owns these keys while it's open: no slide shortcuts, and Esc
    // doesn't also deselect what the panel is showing.
    e.preventDefault();
    e.stopPropagation();
}

function onOutside(e) {
    if (!_open) return;
    if (_open.menu.contains(e.target) || _open.box.contains(e.target)) return;
    close();
}

function onScroll(e) {
    if (_open && !_open.menu.contains(e.target)) close();
}
