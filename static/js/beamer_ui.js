// beamer_ui.js
export function setControlsEnabledAfterUpload(enabled, controls) {
    const list = controls || [];
    list.forEach(btn => {
        if (btn && btn.el) {
            btn.el.disabled = !enabled;
            btn.el.style.opacity = enabled ? '1' : '0.5';
            btn.el.style.cursor = enabled ? 'pointer' : 'not-allowed';
            btn.el.style.pointerEvents = enabled ? 'auto' : 'none';
        }
    });
}

export function disableControlButtons(disable, controls, surveyResultsBtn) {
    const all = controls || [];
    all.forEach(btn => {
        if (btn && btn.el) {
            btn.el.disabled = disable;
            btn.el.style.opacity = disable ? '0.5' : '1';
            btn.el.style.cursor = disable ? 'not-allowed' : 'pointer';
            btn.el.style.pointerEvents = disable ? 'none' : 'auto';
        }
    });

    if (surveyResultsBtn && surveyResultsBtn.el) {
        surveyResultsBtn.el.disabled = false;
        surveyResultsBtn.el.style.opacity = '1';
        surveyResultsBtn.el.style.cursor = 'pointer';
        surveyResultsBtn.el.style.pointerEvents = 'auto';
    }
}
