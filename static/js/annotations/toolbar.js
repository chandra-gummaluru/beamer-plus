// Annotation toolbar — owns tool selection (pen/eraser/laser/shape/select).
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
            const shapeSidebar = document.getElementById('shape-sidebar');
            if (shapeSidebar) shapeSidebar.style.display =
                btn.dataset.tool === 'shape' ? 'flex' : 'none';
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
