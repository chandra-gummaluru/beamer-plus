// Annotation toolbar — owns tool selection (hand, spotlight, magnifier, text, eraser).
import { bus } from '../core/events.js';

export function initToolbar(state) {
    const tools = document.querySelectorAll('#tool-container .tool-btn');
    tools.forEach(btn => {
        btn.addEventListener('click', () => {
            // Clear selection across the whole rail, not just the buttons this
            // module queried at init — pen slots are added afterwards (by
            // initPenSlots) and have their own 'btn_selected' class to clear too.
            document.querySelectorAll('#tool-container .btn').forEach(b => b.classList.remove('btn_selected'));
            btn.classList.add('btn_selected');
            state.annotationTool = btn.dataset.tool;
            // Note: the text-size sidebar is deliberately NOT shown here —
            // it only appears once a textbox is actually open (see
            // main.js's textbox:opened/closed listeners), not just because
            // the Text tool got selected.
            bus.emit('tool:change', btn.dataset.tool);
        });
    });
    // Note: undo / redo / clear buttons are wired directly to the canvas in
    // main.js (wireUndoRedo / wireAnnotationClear), so they're not handled here.
}
