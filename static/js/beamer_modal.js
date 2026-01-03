// beamer_modal.js
export const Modal = {
    show(type, title, message, onConfirm = null) {
        const existingModal = document.querySelector('.custom-modal-overlay');
        if (existingModal) existingModal.remove();
        
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay';
        
        const iconClass = {
            info: 'fa-circle-info',
            error: 'fa-regular-circle-xmark',
            warning: 'fa-triangle-exclamation',
            success: 'fa-regular-circle-check',
            confirm: 'fa-regular-circle-question'
        }[type] || 'fa-circle-info';
        
        overlay.innerHTML = `
            <div class="custom-modal-content">
                <div class="custom-modal-icon">
                    <i class="fas ${iconClass}"></i>
                </div>
                <h2 class="custom-modal-title">${title}</h2>
                <p class="custom-modal-message">${message}</p>
                <div class="custom-modal-buttons">
                    ${type === 'confirm' ? '<button class="custom-modal-btn custom-modal-btn-cancel">Cancel</button>' : ''}
                    <button class="custom-modal-btn custom-modal-btn-ok">${type === 'confirm' ? '<i class="fa-solid fa-thumbs-up"></i>' : '<i class="fa-solid fa-thumbs-up"></i>'}</button>
                </div>
            </div>
        `;
        
        // Add type class for styling
        overlay.classList.add(`modal-${type}`);
        
        document.body.appendChild(overlay);
        
        const okBtn = overlay.querySelector('.custom-modal-btn-ok');
        const cancelBtn = overlay.querySelector('.custom-modal-btn-cancel');
        
        const close = (confirmed = false) => {
            overlay.remove();
            if (confirmed && onConfirm) onConfirm();
        };
        
        okBtn.onclick = () => close(true);
        if (cancelBtn) cancelBtn.onclick = () => close(false);
        overlay.onclick = (e) => {
            if (e.target === overlay) close(false);
        };
        
        okBtn.focus();
        
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                close(false);
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    },
    
    loading(title, message) {
        const existingModal = document.querySelector('.custom-modal-overlay');
        if (existingModal) existingModal.remove();
        
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay modal-loading';
        overlay.innerHTML = `
            <div class="custom-modal-content">
                <svg class="custom-modal-squiggle" viewBox="0 0 120 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M2 20 C20 2, 40 38, 58 20 C76 2, 96 38, 118 20" />
                </svg>
                <h2 class="custom-modal-title">${title}</h2>
                <p class="custom-modal-message">${message}</p>
            </div>
        `;
        
        document.body.appendChild(overlay);
        
        return {
            close: () => overlay.remove()
        };
    },
    
    info(title, message) { this.show('info', title, message); },
    error(title, message) { this.show('error', title, message); },
    warning(title, message) { this.show('warning', title, message); },
    success(title, message) { this.show('success', title, message); },
    confirm(title, message, onConfirm) { this.show('confirm', title, message, onConfirm); }
};
