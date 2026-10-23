// Modal manager — paper card with backdrop blur.
// Public API: BeamerModal.show({ kind, title, message, buttons, body })
const Modal = {
    open: null,
    show({ kind = 'info', title = '', message = '', body = null, buttons = [{ label: 'OK', kind: 'ok' }], canClose = null, onClose = null } = {}) {
        this.close();
        const overlay = document.createElement('div');
        overlay.className = `custom-modal-overlay modal-${kind}`;
        const content = document.createElement('div');
        content.className = 'custom-modal-content';

        // title and message are always assigned via textContent (never
        // interpolated into innerHTML) — they routinely carry untrusted text
        // such as filenames, survey questions, or raw server error strings.
        if (kind === 'loading') {
            overlay.classList.add('modal-loading');
            content.innerHTML = `
                <svg class="custom-modal-squiggle" viewBox="0 0 120 40">
                    <path d="M5 20 Q 15 5, 25 20 T 45 20 T 65 20 T 85 20 T 105 20" />
                </svg>
                <h3 class="custom-modal-title"></h3>
                <p class="custom-modal-message"></p>
            `;
            content.querySelector('.custom-modal-title').textContent = title || 'Loading…';
            content.querySelector('.custom-modal-message').textContent = message;
        } else {
            const icon = { error: '✕', success: '✓', warning: '!' }[kind] || '';
            content.innerHTML = `
                ${icon ? `<div class="custom-modal-icon">${icon}</div>` : ''}
                ${title ? '<h3 class="custom-modal-title"></h3>' : ''}
                ${message ? '<p class="custom-modal-message"></p>' : ''}
                <div class="custom-modal-body"></div>
                <div class="custom-modal-buttons"></div>
            `;
            if (title)   content.querySelector('.custom-modal-title').textContent = title;
            if (message) content.querySelector('.custom-modal-message').textContent = message;
            // Top-right X close button (matches widget-modal-close style)
            const xBtn = document.createElement('button');
            xBtn.className = 'custom-modal-x-btn';
            xBtn.title = 'Close';
            xBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            xBtn.addEventListener('click', () => { if (canClose && !canClose()) return; this.close(); });
            content.appendChild(xBtn);

            const bodySlot = content.querySelector('.custom-modal-body');
            if (body instanceof Node) bodySlot.appendChild(body);
            else if (typeof body === 'string') bodySlot.innerHTML = body;

            const btnRow = content.querySelector('.custom-modal-buttons');
            buttons.forEach(b => {
                const btn = document.createElement('button');
                btn.className = `custom-modal-btn custom-modal-btn-${b.kind || 'cancel'}`;
                btn.textContent = b.label;
                btn.addEventListener('click', () => { if (b.guard && !b.guard()) return; b.onClick?.(); this.close(); });
                btnRow.appendChild(btn);
            });
        }

        overlay.appendChild(content);
        overlay.addEventListener('click', (e) => { if (e.target === overlay && kind !== 'loading') { if (canClose && !canClose()) return; this.close(); } });
        document.body.appendChild(overlay);
        this.open = overlay;
        this._onClose = onClose;   // called once, however it closes
    },
    close() {
        if (this.open) { this.open.remove(); this.open = null; }
        const cb = this._onClose;
        this._onClose = null;
        if (typeof cb === 'function') { try { cb(); } catch (e) { console.error('[modal] onClose', e); } }
    },
};

export function initModal() {
    window.BeamerModal = Modal;
}
