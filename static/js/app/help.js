// Help & Settings — the combined modal opened from the single menu button.
// Bundles the usage guide, a Settings tab, and a "Take a tour" launcher.

import { buildSettingsPanel } from './settings.js';

function _hic(s) { return `<code class="help-ic">${s}</code>`; }

// Small inline icon chip matching the actual button SVGs in the UI
const _HELP_ICONS = {
    upload:    `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>`,
    download:  `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`,
    edit:      `<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>`,
    split:     `<rect x="2" y="3" width="20" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>`,
    focus:     `<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`,
    bookmark:  `<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>`,
    hand:      `<path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>`,
    spotlight: `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>`,
    pen:       `<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>`,
    eraser:    `<path d="M7 21h10"/><path d="m5 11 9-9 6 6-9 9H5z"/>`,
    video:     `<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>`,
    audio:     `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`,
    model3d:   `<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>`,
    widget:    `<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>`,
};
function _hbtn(key, label) {
    return `<span class="help-btn-ref" title="${label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${_HELP_ICONS[key]}</svg></span>`;
}

const _TOUR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`;

export function showHelpModal({ onStartTour = null } = {}) {
    const settings = buildSettingsPanel();
    // The how-to content is grouped into a single Help tab; each entry below is
    // one topic block, joined with dividers.
    const topics = [
        {
            id: 'start', label: 'Getting Started',
            html: `
<h4 class="help-h">Loading a presentation</h4>
<p class="help-p">Click the upload button ${_hbtn('upload','Upload')} in the top-right corner. You can load two types of file:</p>
<ul class="help-ul">
  <li>Your bare slide deck (as a PDF). Once loaded you can annotate it and place interactive widgets on any slide.</li>
  <li>A saved Beamer+ presentation (as a ZIP) that bundles the PDF together with all your widgets, overlays, and annotations. To create one, start from a bare slide deck, edit it in Beamer+, then click the download button ${_hbtn('download','Save & download')}. Beamer+ packages everything into a ZIP you can reload later.</li>
</ul>`,
        },
        {
            id: 'present', label: 'Presenting',
            html: `
<h4 class="help-h">Navigating slides</h4>
<ul class="help-ul">
  <li>Press ${_hic('←')} ${_hic('→')} or click any slide in the left navigator.</li>
<li>Bookmark a slide with the ${_hbtn('bookmark','Bookmark')} button at the bottom of the navigator. Bookmarked slides get a pin so you can jump to them instantly.</li>
</ul>
<h4 class="help-h">Split view</h4>
<p class="help-p">Click ${_hbtn('split','Split view')} at the top of the navigator to display two slides side by side, handy for comparing pages or keeping a reference slide visible while you present another.</p>
<h4 class="help-h">Focus mode</h4>
<p class="help-p">Click ${_hbtn('focus','Focus mode')} in the top-right to hide all UI and show only the slide. Press ${_hic('Esc')} to exit.</p>
<h4 class="help-h">Annotation tools</h4>
<p class="help-p">The floating toolbar on the left lets you draw directly on slides. Annotations are saved per slide.</p>
<ul class="help-ul">
  <li>${_hbtn('hand','Hand')} <strong>Hand</strong>: default mode, no drawing.</li>
  <li>${_hbtn('spotlight','Spotlight')} <strong>Spotlight</strong>: dims the slide and highlights your cursor position.</li>
  <li>${_hbtn('pen','Pen')} <strong>Pen</strong>: freehand drawing. Click the pen icon again to change colour and size.</li>
  <li>${_hbtn('eraser','Eraser')} <strong>Eraser</strong>: erase individual strokes.</li>
</ul>`,
        },
        {
            id: 'edit', label: 'Editing',
            html: `
<h4 class="help-h">Entering edit mode</h4>
<p class="help-p">Click the edit button ${_hbtn('edit','Edit mode')} in the top-right corner. A panel opens on the right where you can select, configure, and delete anything on the current slide.</p>
<h4 class="help-h">Adding overlays</h4>
<p class="help-p">The buttons at the bottom of the editor panel let you add content on top of your slides:</p>
<ul class="help-ul">
  <li>${_hbtn('video','Add video')} <strong>Video</strong>: overlay a video player.</li>
  <li>${_hbtn('audio','Add audio')} <strong>Audio</strong>: overlay an audio clip.</li>
  <li>${_hbtn('model3d','Add 3D model')} <strong>3D Model</strong>: embed a rotatable ${_hic('.glb')} or ${_hic('.gltf')} model.</li>
  <li>${_hbtn('widget','Add widget')} <strong>Widget</strong>: add an interactive widget (see the Widgets section).</li>
</ul>
<h4 class="help-h">Moving &amp; resizing</h4>
<p class="help-p">Drag any overlay to reposition it, or drag its bottom-right corner to resize. The Properties panel shows exact position, size, and layer controls.</p>
<h4 class="help-h">Saving your work</h4>
<p class="help-p">Click ${_hbtn('download','Save & download')} to save your presentation. All overlays, widgets, and annotations are included.</p>`,
        },
        {
            id: 'widgets', label: 'Widgets',
            html: `
<h4 class="help-h">What is a widget?</h4>
<p class="help-p">Widgets are interactive tools that live directly on your slides: live polls, coding environments, timers, and more.</p>
<h4 class="help-h">Adding a widget</h4>
<p class="help-p">In edit mode, click ${_hbtn('widget','Add widget')} at the bottom of the panel. Beamer+ comes with a built-in library to get you started, and you can also create your own custom widgets (see below).</p>
<hr class="help-divider">
<h4 class="help-h">Building a custom widget</h4>
<p class="help-p">A widget is a single self-contained ${_hic('.html')} file. Beamer+ loads it in an isolated iframe and handles the rest: persistence, resizing, and state saving.</p>
<h4 class="help-h">1 · Declare your settings</h4>
<p class="help-p">Put a schema block at the top of ${_hic('&lt;head&gt;')}. Beamer+ builds a settings panel inside your widget from it — the presenter opens it with the gear on your widget in edit mode. The editor's own panel only ever shows your widget's position and size:</p>
<code class="help-code">&lt;script id="widget-schema" type="application/json"&gt;
{
  "label": "My Widget",
  "category": "Tools",
  "fields": [
    { "key": "title",   "label": "Title",      "type": "text",     "placeholder": "Hello" },
    { "key": "count",   "label": "Count",      "type": "number",   "min": 1, "step": 1 },
    { "key": "autorun", "label": "Auto-start", "type": "checkbox", "default": false }
  ]
}
&lt;/script&gt;</code>
<p class="help-p">Supported types: ${_hic('text')}, ${_hic('password')}, ${_hic('number')}, ${_hic('number-nullable')}, ${_hic('checkbox')}, ${_hic('select')}, ${_hic('textarea')}, ${_hic('textarea-lines')}, ${_hic('file')}, ${_hic('ai-model')}.</p>
<p class="help-p">Want your own settings UI instead? Add ${_hic('"customSettings": true')} to the schema and handle ${_hic('widget-open-settings')} yourself — Beamer+ will leave the panel entirely to you.</p>
<h4 class="help-h">2 · Read configuration</h4>
<p class="help-p">Beamer+ injects ${_hic('window.WIDGET_CONFIG')} before your widget loads. It contains the field values the presenter set, plus layout info:</p>
<code class="help-code">const cfg = window.WIDGET_CONFIG || {};
// cfg.title, cfg.count, cfg.autorun  ← your declared fields
// cfg.role  →  'presenter' or 'viewer'</code>
<h4 class="help-h">3 · Communicate with Beamer+</h4>
<dl class="help-kv">
  <dt>widget-expand</dt><dd>Post to <code class="help-ic">window.parent</code> to animate the widget to full-slide size.</dd>
  <dt>widget-collapse</dt><dd>Return to the original size.</dd>
  <dt>widget-get-state</dt><dd>Received when navigating away. Reply with a ${_hic('widget-state')} message containing serialisable state.</dd>
  <dt>widget-set-state</dt><dd>Received when returning to the slide. Restore your UI from the saved state.</dd>
  <dt>widget-cleanup</dt><dd>Received when the widget is removed. Stop timers and release resources.</dd>
  <dt>widget-open-settings</dt><dd>Received when the presenter clicks your gear. Handled for you unless you set ${_hic('customSettings')}.</dd>
  <dt>widget-close-settings</dt><dd>Received when Beamer+ needs your settings closed (slide change, leaving edit mode).</dd>
  <dt>widget-settings</dt><dd>Post ${_hic('{ widgetId, patch, remove }')} to save settings into your config item, where they persist with the deck.</dd>
</dl>
<h4 class="help-h">4 · Shared styles</h4>
<p class="help-p">Every widget automatically inherits Beamer+'s design tokens, with no setup needed:</p>
<code class="help-code">var(--bg)        var(--text)      var(--border)
var(--accent)    var(--font-ui)   var(--font-mono)
var(--radius)    /* …and more */</code>
<p class="help-p">Your own ${_hic(':root')} block overrides any token you want to customise.</p>`,
        },
    ];

    const sections = [
        {
            id: 'help', label: 'Help', tour: true,
            html: topics.map(t => t.html).join('<hr class="help-divider">'),
        },
        {
            id: 'settings', label: 'Settings', node: settings.node,
        },
    ];

    const wrap = document.createElement('div');
    wrap.className = 'help-modal-wrap';

    const nav = document.createElement('nav');
    nav.className = 'help-modal-nav';
    nav.setAttribute('aria-label', 'Help sections');

    const pane = document.createElement('div');
    pane.className = 'help-modal-pane';

    sections.forEach((s, i) => {
        const btn = document.createElement('button');
        btn.className = 'help-modal-nav-btn' + (i === 0 ? ' active' : '');
        btn.textContent = s.label;
        btn.addEventListener('click', () => {
            nav.querySelectorAll('.help-modal-nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            pane.querySelectorAll('.help-section').forEach(sec => sec.classList.remove('active'));
            document.getElementById('help-sec-' + s.id)?.classList.add('active');
        });
        nav.appendChild(btn);

        const sec = document.createElement('div');
        sec.className = 'help-section' + (i === 0 ? ' active' : '');
        sec.id = 'help-sec-' + s.id;
        if (s.node) sec.appendChild(s.node);
        else sec.innerHTML = s.html;

        // Guided-tour launcher — a full-width callout at the top of the Help tab.
        if (s.tour && onStartTour) {
            const tourBtn = document.createElement('button');
            tourBtn.className = 'help-tour-cta';
            tourBtn.type = 'button';
            tourBtn.innerHTML = `
                <span class="help-tour-cta-icon">${_TOUR_ICON}</span>
                <span class="help-tour-cta-text">
                    <strong>New to Beamer+? Take the guided tour</strong>
                    <span>A quick walkthrough of the main features</span>
                </span>
                <span class="help-tour-cta-arrow" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                </span>`;
            tourBtn.addEventListener('click', () => { window.BeamerModal?.close(); onStartTour(); });
            sec.insertBefore(tourBtn, sec.firstChild);
        }

        pane.appendChild(sec);
    });

    wrap.appendChild(nav);
    wrap.appendChild(pane);

    const buttons = [{ label: 'Done', kind: 'ok', guard: () => !settings.hasConflicts() }];

    window.BeamerModal?.show({
        kind: 'info',
        title: 'Help & Settings',
        body: wrap,
        canClose: () => !settings.hasConflicts(),
        buttons,
    });

    // Widen the modal card for this documentation layout
    window.BeamerModal?.open
        ?.querySelector('.custom-modal-content')
        ?.classList.add('help-modal-content');
}
