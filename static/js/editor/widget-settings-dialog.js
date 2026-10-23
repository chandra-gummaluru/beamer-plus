// A widget's own settings, in a dialog opened from the widget itself.
//
// Every widget is self-contained: its specific settings (a poll's question,
// a timer's duration, a video's link…) are edited from the pencil button in
// the widget's own top bar (or, for one laid over part of a slide without a
// bar, the pencil that shows on hover). The editor's panel keeps only what
// every widget has — Name, Text size and where it sits (widget-panel.js).
//
// Protocol
//   ← widget   widget-edit-settings   { widgetId }   open this dialog
//
// The dialog is the same form the editor used to show (widget-fields.js,
// 'modal' variant: two columns when there is long content), read from the
// widget's `widget-schema` block, minus Name and Text size. Changes go onto
// the widget's config item as they're made; when the dialog closes the slide
// re-renders, and the widget — its settings changed — is rebuilt with them.
import { bus } from '../core/events.js';
import { widgetIdForWindow } from '../core/iframe-widget-renderer.js';
import { getWidgetSchema } from './widget-schema.js';
import { buildWidgetForm } from './widget-fields.js';
import { findWidgetItem } from './widget-settings.js';

// What the editor panel edits instead (widget-panel.js).
export const GENERAL_KEYS = new Set(['title', 'scale']);

/** The widget's own fields: everything but Name and Text size. */
export const ownFields = (schema) => (schema?.fields || []).filter(f => !GENERAL_KEYS.has(f.key));

export function initWidgetSettingsDialog() {
    window.addEventListener('message', (e) => {
        if (e.data?.type !== 'widget-edit-settings') return;
        // Only from one of our own widget iframes, speaking for itself.
        const id = widgetIdForWindow(e.source);
        if (id === null || id !== String(e.data.widgetId)) return;
        openWidgetSettings(id);
    });
}

export async function openWidgetSettings(widgetId) {
    const item = findWidgetItem(widgetId);
    if (!item) return;
    const schema = await getWidgetSchema(item);
    const fields = ownFields(schema);
    const title = `${item.title || schema?.label || 'Widget'} settings`;
    if (!fields.length) {
        window.BeamerModal?.show({ kind: 'info', title, message: 'This widget has no settings of its own.' });
        return;
    }
    const form = buildWidgetForm({ ...schema, fields }, item, 'modal');
    const before = JSON.stringify(item);
    const apply = () => { form.apply(item); form.syncVisibility(); };
    form.node.addEventListener('input', apply);
    form.node.addEventListener('change', apply);

    window.BeamerModal?.show({
        kind: 'info',
        title,
        body: form.node,
        buttons: [{ label: 'Done', kind: 'ok' }],
        onClose: () => {
            apply();
            // Rebuild the widget only if something actually changed.
            if (JSON.stringify(item) !== before) bus.emit('widgets:changed');
        },
    });
    window.BeamerModal?.open?.querySelector('.custom-modal-content')?.classList.add('widget-settings-modal');
    setTimeout(() => form.focusFirst?.(), 0);
}
