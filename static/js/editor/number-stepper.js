// Number steppers — every numeric field in the editor panel is shown as
// [ − ]  value  [ + ] instead of the browser's own number box.
//
//   • click − / + to step (hold to repeat; Shift steps ×10)
//   • hover and scroll the wheel to step up / down (Shift ×10)
//   • click the number to type one; arrow keys still work
//   • a field with a non-numeric placeholder (e.g. "—" for "Appear on
//     step") steps down from its minimum to blank, and up from blank to
//     its minimum — blank keeps whatever meaning that field gives it
//
// The <input type="number"> stays the real control: it is wrapped, not
// replaced, so code that reads .value or listens for input/change on it
// carries on unchanged. Steps fire `input` then `change`, both bubbling.
// Panels rebuild their fields freely, so a MutationObserver upgrades any
// new number input that lands in the panel.

const SEL = 'input[type="number"].editor-prop-input';
const HOLD_DELAY = 380, HOLD_EVERY = 70;

export function initNumberSteppers(root = document.getElementById('editor-panel')) {
    if (!root) return;
    root.querySelectorAll(SEL).forEach(enhance);
    new MutationObserver(muts => {
        for (const m of muts) for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.matches?.(SEL)) enhance(n);
            n.querySelectorAll?.(SEL).forEach(enhance);
        }
    }).observe(root, { childList: true, subtree: true });
}

function enhance(input) {
    if (input.dataset.stepper || input.closest('.num-stepper')) return;
    input.dataset.stepper = '1';

    const wrap = document.createElement('span');
    wrap.className = 'num-stepper';
    input.replaceWith(wrap);

    // Spans, not buttons: these often sit inside a <label>, whose click
    // would otherwise land on the first button instead of the number.
    const btn = (dir, glyph, name) => {
        const b = document.createElement('span');
        b.className = `num-stepper-btn num-stepper-btn--${dir < 0 ? 'down' : 'up'}`;
        b.setAttribute('aria-hidden', 'true');
        b.title = `${name} (Shift: ×10)`;
        b.innerHTML = glyph;
        wireHold(b, input, dir);
        return b;
    };
    const minus = '<svg viewBox="0 0 12 12" width="10" height="10"><path d="M2.5 6h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    const plus  = '<svg viewBox="0 0 12 12" width="10" height="10"><path d="M2.5 6h7M6 2.5v7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

    // A unit printed after the number (the layout card's "%") moves inside.
    const field = document.createElement('span');
    field.className = 'num-stepper-field';
    field.appendChild(input);
    const unit = wrap.nextElementSibling?.tagName === 'I' ? wrap.nextElementSibling : null;
    if (unit) { unit.classList.add('num-stepper-unit'); field.appendChild(unit); wrap.parentElement.classList.add('has-stepper'); }

    wrap.append(btn(-1, minus, 'Decrease'), field, btn(+1, plus, 'Increase'));

    const syncState = () => wrap.classList.toggle('is-readonly', input.readOnly || input.disabled);
    syncState();
    new MutationObserver(syncState).observe(input, { attributes: true, attributeFilter: ['readonly', 'disabled'] });

    // Scroll while hovering. A mouse notch is one step; a trackpad's stream
    // of small deltas is pooled so a gentle swipe doesn't race away.
    let pool = 0, poolTimer = 0;
    wrap.addEventListener('wheel', (e) => {
        if (input.readOnly || input.disabled) return;
        e.preventDefault();
        const d = e.deltaY || e.deltaX;
        if (!d) return;
        let steps = 0;
        if (e.deltaMode !== 0 || Math.abs(d) >= 50) steps = 1 * -Math.sign(d);
        else {
            pool += d;
            clearTimeout(poolTimer); poolTimer = setTimeout(() => { pool = 0; }, 200);
            if (Math.abs(pool) >= 24) { steps = -Math.sign(pool); pool = 0; }
        }
        if (steps) bump(input, steps, e.shiftKey);
    }, { passive: false });

    // Clicking into the number selects it, ready to type over.
    input.addEventListener('focus', () => requestAnimationFrame(() => {
        if (document.activeElement === input) try { input.select(); } catch { /* ignore */ }
    }));
}

function wireHold(b, input, dir) {
    let t1 = 0, t2 = 0;
    const stop = () => { clearTimeout(t1); clearInterval(t2); };
    b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || input.readOnly || input.disabled) return;
        e.preventDefault();
        bump(input, dir, e.shiftKey);
        t1 = setTimeout(() => { t2 = setInterval(() => bump(input, dir, e.shiftKey), HOLD_EVERY); }, HOLD_DELAY);
        b.setPointerCapture?.(e.pointerId);
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('lostpointercapture', stop);
    // Keep a surrounding <label> from forwarding the click to the input.
    b.addEventListener('click', (e) => e.preventDefault());
}

const decimals = (s) => { const m = String(s).match(/\.(\d+)/); return m ? m[1].length : 0; };

function bump(input, dir, big) {
    const stepAttr = input.step && input.step !== 'any' ? input.step : '1';
    const step = parseFloat(stepAttr) || 1;
    const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
    const max = input.max !== '' ? parseFloat(input.max) : Infinity;
    const ph = input.placeholder?.trim() ?? '';
    const phNum = ph !== '' && isFinite(Number(ph)) ? Number(ph) : NaN;
    const blankable = ph !== '' && isNaN(phNum);   // e.g. "—": blank means something

    const raw = input.value.trim();
    let cur = raw === '' ? NaN : parseFloat(raw);
    let next;
    if (isNaN(cur)) {
        if (!isNaN(phNum)) next = phNum + dir * step * (big ? 10 : 1);
        else if (dir > 0) next = isFinite(min) ? min : 0;
        else return;                                     // blank, going down: stay blank
    } else {
        if (blankable && dir < 0 && cur <= min) return set(input, '');
        next = cur + dir * step * (big ? 10 : 1);
    }
    next = Math.min(max, Math.max(min, next));
    const p = Math.max(decimals(stepAttr), decimals(input.min || 0));
    const out = p ? next.toFixed(p).replace(/\.?0+$/, '') : String(Math.round(next));
    if (out === raw) return;
    set(input, out);
}

function set(input, v) {
    input.value = v;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}
