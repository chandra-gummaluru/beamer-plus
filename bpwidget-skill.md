---
name: beamer-widgets
description: Build or modify Beamer+ slide widgets — single self-contained HTML files that run in a Beamer+ iframe. Use when asked for a new widget, a change to an existing widget, or anything that must match Beamer+ widget style, structure, or the host config/sync protocol.
---

# Beamer+ Widget Authoring

A widget is **one self-contained HTML file** loaded into an iframe on a Beamer+ slide.
The host injects its design tokens and `static/css/widget-base.css` **before** the
widget's own `<style>`, passes configuration in by `postMessage`, and may run the same
file twice: once for the presenter and once for every viewer.

Every new widget matches the house style below. When editing an existing widget, follow
that file's local conventions first — consistency inside a file beats consistency with
this document.

---

## 1. File anatomy — keep this order

```
<!DOCTYPE html>
<html lang="en">
<head>
  <script id="widget-schema" type="application/json"> … </script>   ← FIRST in <head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thing — Beamer+</title>
  <script src="/static/vendor/…"></script>       ← vendored libs
  <script src="https://cdn…/lib@X.Y.Z/…"></script> ← pinned CDN libs, if unavoidable
  <style> … </style>                             ← only what THIS widget owns
</head>
<body>
  <div id="shell" class="bw-shell">
    <div id="toolbar" class="bw-toolbar" data-bw-topbar> … </div>
    <div id="…-view"> … </div>
  </div>
  <script> (function () { 'use strict'; … })(); </script>
</body>
</html>
```

Rules:

- **No build step, no framework, no bundler.** Plain HTML + CSS + ES2020 JS.
- **One file.** Inline the CSS and JS. (`cortexc.html` is the exception — it is a
  generated bundle with a `GENERATED FILE — do not edit by hand` banner at the top.)
- The script body lives in an **IIFE with `'use strict'`**. The only exception is when
  inline `onclick="…"` handlers need globals — then skip the IIFE and explicitly
  `window.foo = foo;` at the bottom (e.g. `calculator.html`).
- `<title>` is always `<Widget Name> — Beamer+`.

---

## 2. The widget schema block

The first thing in `<head>`. Beamer+ reads it to build the slide's config panel.

```html
<script id="widget-schema" type="application/json">
{
  "label": "Audience Response",
  "category": "Audience Response",
  "fields": [
    { "key": "question", "label": "Question", "type": "textarea", "rows": 3,
      "placeholder": "Enter the question…" }
  ]
}
</script>
```

- `label` — human name shown in the widget picker.
- `category` — one of: `Tools`, `Mathematics`, `Computer Science`, `Audience Response`.
  Add a new one only if none fits.
- `fontSize: false` — opt out of the host's font-size control (e.g. `map.html`).
- `fields: []` — a widget with nothing to configure still declares the empty array.

### Field types

| `type`            | Extra keys                        | Value handed to the widget |
|-------------------|-----------------------------------|----------------------------|
| `text`            | `placeholder`                     | string |
| `textarea`        | `rows`, `placeholder`             | string |
| `textarea-lines`  | `rows`, `placeholder`             | string (split it yourself) or array |
| `number`          | `min`, `max`, `step`, `default`   | number |
| `number-nullable` | `min`, `step`                     | number or null |
| `checkbox`        | `default`                         | boolean |
| `select`          | `options`, `default`              | `["1","1.4"]` or `[{ "v": 500, "l": "Normal" }]` |
| `file`            | `accept`, `folder` (`"assets"`)   | relative path — resolve via `/api/zip-asset/` |
| `password`        | `placeholder`                     | string |
| `ai-model`        | —                                 | model id string |

Any field may add `"showIf": { "otherKey": "value" }` (or a list of values) to
appear only while another field holds that value — e.g. the answer list in
`audience-response.html` shows only when `responseType` is `"choice"`. Hidden
fields keep their values.

Every widget with a schema also gets a **Name** field (key `title`), added by
the settings kit and the editor — don't declare it. It is the widget's title
everywhere: the bar, the heading of any exported PDF, and every downloaded
file. Read it with `BeamerWidget.name(fallback)` and name downloads with
`BeamerWidget.fileName(fallbackStem, '.pdf')`; both fall back to the widget's
own default when the Name is blank.

Conventional field keys reused across widgets: `autoStart`, `autoplay`, `readOnly`,
`scale` (text size, `select` of `"1" | "1.4" | "1.8" | "2.2"`, default `"1.4"`).

---

## 3. Styling — consume tokens, never redefine them

`widget-base.css` is injected ahead of the widget's `<style>`. **Do not declare a
`:root` block of `--bg`, `--text`, `--border`, … in a new widget** — that is the older
pattern still present in `calculator.html`, `function-plotter.html`, `pdf.html` and
`timer.html`, and it drops out of light/dark support.

Open the `<style>` with a comment saying what the base provides and what is left:

```css
/* Tokens, reset, toolbar, buttons and status pills come from the shared
   widget base (static/css/widget-base.css). What's left here is the poll
   itself: the question, the choice pills, the QR panel, the result bars. */
```

### Tokens available

| Group   | Tokens |
|---------|--------|
| Surface | `--bg`, `--bg-subtle`, `--bg-output` |
| Line    | `--border`, `--border-med`, `--radius` |
| Ink     | `--text`, `--text-2`, `--text-3` |
| Accent  | `--accent`, `--accent-bg` |
| Signal  | `--ok`, `--err`, `--warn` |
| Type    | `--font-ui`, `--font-mono` |
| Size    | `--fs-head`, `--fs-body`, `--fs-small`, `--fs-code`, `--fs-chrome`, `--fs-chrome-sm`, `--u` |
| Motion  | `--dur` |
| Charts  | `--chart-1` … `--chart-6` |

`--u` is the host's scale factor. Any size a presenter should be able to grow is
`calc(13px * var(--u))` or, better, one of the `--fs-*` tokens. Fixed chrome (a 42px
toolbar, a 28px button) stays in raw px.

**Canvas and other non-CSS surfaces** must read the tokens at draw time — see
a `themeInk()`-style helper that reads `getComputedStyle` at draw time — otherwise they bake light-mode ink onto a dark deck.

**A widget that also has to run standalone** (opened outside Beamer+) consumes with a
fallback and namespaces its own aliases, as `cortexc.html` does:

```css
:root {
  --cx-bg:   var(--bg,   #ffffff);
  --cx-text: var(--text, #1a1a18);
}
```

### Furniture classes from the base

```
.bw-shell                                    column flex, full height
.bw-toolbar  .bw-toolbar-title  .bw-sep  .bw-spacer  .bw-status
.bw-btn  .bw-btn--primary  .bw-btn--icon  .is-active
.bw-card  .bw-card--lg  .bw-card-meta
.bw-center  .bw-hint  .bw-empty
.bw-spinner  .bw-boot  .bw-boot-msg  .bw-boot-sub
.bw-banner  .bw-banner--error
.bw-md                                       markdown/KaTeX output container
```

The toolbar element also carries `data-bw-topbar` so the host can find it.

### Visual house style

- Flat surfaces, hairline 1px borders, `var(--radius)` (6px). No drop shadows except
  floating things (popups, a lifted PDF page, an overlay card).
- Colour means something. Neutral greys are the default; `--ok` / `--err` / an accent
  hue appear only to carry state. Don't tint region headers or panel chrome.
- One primary action per toolbar, inverted (`bw-btn--primary` / dark fill, white text).
- Transitions 0.1–0.2s on `background`, `border-color`, `color`. Honour
  `@media (prefers-reduced-motion: reduce)` if the widget animates.
- Centred content sits slightly **above** true centre: `padding-bottom: 10%`.
- Scrollbars: 4–8px, `--border` thumb, `--border-med` on hover; hide them entirely
  where a visible bar would fight the layout.
- Uppercase 10px 0.08em-tracked labels for section/region headers.
- Icons are inline SVG, `stroke="currentColor"`, `stroke-width` 1.2–2.5, never an icon font.
- The widget fills its iframe: `html, body { height: 100%; overflow: hidden; }` and the
  panes flex inside it. Nothing scrolls the page itself.

---

## 4. The host protocol

### Initial config

Two paths, support both:

```js
const CFG = window.WIDGET_CONFIG || {};      // injected before the widget script
// …and later, by message
window.addEventListener('message', e => {
  if (e.data?.type === 'widget-config') applyConfig(e.data.config);
});
```

`applyConfig` must be **idempotent and re-callable** — it fires again whenever the
presenter edits the slide config.

### Config keys the host always supplies

| Key | Meaning |
|-----|---------|
| `id` / `widgetId` | this widget instance's sync id |
| `role` | `'presenter'` or `'viewer'` |
| `socketUrl` | bare origin, for socket.io |
| `serverUrl` | session-scoped base (`/s/<code>`), for REST calls |
| `publicBaseUrl` | origin to put in QR codes / join links |
| `sessionId` | Beamer+ session, for `join_presenter` |

`serverUrl` vs `socketUrl` matters: REST routes are session-scoped, so
`` `${serverUrl}/api/…` `` is right and `socketUrl` gives a 404. Sockets use the bare
origin. Falling back: `cfg.serverUrl || cfg.socketUrl || window.parent.location.origin`
(wrapped in try/catch — `location.origin` is `"null"` inside a srcdoc iframe).

### Messages in

| `e.data.type` | Do |
|---------------|----|
| `widget-config` | merge into cfg, re-apply |
| `widget-cleanup` | disconnect sockets, cancel timers/rAF, stop media, destroy players |
| `widget-get-state` | reply `postMessage({ type:'widget-state', widgetId, state }, '*')` |
| `widget-set-state` | restore from `e.data.state` |

### Messages out

- `{ type: 'widget-state', widgetId, state }` — the reply above.
- `{ type: 'widget-expand', widgetId }` / `{ type: 'widget-collapse', widgetId }` — ask
  the host to grow or shrink the widget's slide region (`camera.html`).

### `window.BeamerWidget` (optional host helper — always guard for it)

```js
BeamerWidget.serverOrigin()      // bare origin
BeamerWidget.serverUrl()         // session-scoped base
BeamerWidget.topbar.el           // null until the host bar is built
BeamerWidget.topbar.addButton({ label, title, onClick })
BeamerWidget.topbar.onReset(fn)
```

`topbar.el` can be null when the widget boots first — retry on a timer with a bounded
count, as `python-shell.html` does, rather than dropping the buttons silently.

---

## 5. Presenter and viewer

Every widget with state runs in two roles. Decide the role once and branch on it
everywhere:

```js
const IS_VIEWER = cfg.role === 'viewer' || _qs.get('viewer') === '1';
```

A viewer:

- never mutates state locally — every action handler starts with `if (IS_VIEWER) return;`
- has its inputs `readOnly` / `disabled` and its presenter-only buttons hidden
- shows a quiet marker: `.bw-status` badge, or the bottom-right toast
  `View-only · synced with presenter`
- does not open or poll REST endpoints the presenter owns

### Live sync over socket.io

Load from `/static/vendor/socket.io.min.js` — never a CDN — and **never call `io()`
bare**; inside the srcdoc iframe that resolves to `http://about/socket.io/`, which an
HTTPS deck blocks as mixed content. Always pass a URL, and always guard:

```js
function initSocket(url) {
  if (typeof io === 'undefined') { socket = { emit(){}, on(){} }; return; }   // no-op stub
  try {
    const prev = socket;
    socket = io(url || (window.BeamerWidget ? BeamerWidget.serverOrigin() : ''),
                { transports: ['websocket', 'polling'] });
    if (prev && prev.disconnect) prev.disconnect();
    socket.on('widget_state', data => {
      if (!IS_VIEWER || data?.widgetId !== WIDGET_ID) return;
      applyState(data.state || {});
    });
  } catch (_) { socket = { emit(){}, on(){} }; }
}
```

Two event shapes exist in the codebase. Pick one per widget and stay with it:

```js
socket.emit('widget_state', { widgetId, state });                      // most widgets
socket.emit('widget_event', { id: widgetId, type: 'state', payload }); // calculator, plotter
```

Emission is **always debounced** (80–300ms) so a drag, a keystroke burst or a slider
doesn't flood the room. Audience-response widgets additionally join the session:
`socket.emit('join_presenter', { session_id: cfg.sessionId })` on connect.

### State persistence

`getState()` / `applyState()` serve both live sync and saving with the deck — same
shape, so a restored slide looks like a synced viewer. Save what should come back, not
what would re-fire: the Python shell saves its transcript but not its namespace; the
timer restores paused; the word cloud stores a palette **index**, not a colour literal,
because the literal would be wrong in the other theme. Cap what you keep
(`entries.slice(-400)`).

---

## 6. Server endpoints available

| Route | Use |
|-------|-----|
Question text in the audience-response widget is Markdown with KaTeX and
fenced code blocks (marked 9.1.6 + KaTeX 0.16.9, both pinned); the phone
response templates render the same thing, so a listing on the slide is a
listing in the student's hand.

| `POST /api/survey/create` | `{ question, kind?, options?, meta?, model, num_summaries }` — `kind`: open · choice · truefalse · rating · numeric · wordcloud → `{ survey_id, url }` |
| `GET  /api/survey/<id>/responses?after=<n>` | poll responses (3s interval is the convention) |
| `POST /api/survey/<id>/close` | close the poll |
| `POST /api/survey/<id>/analyze` | AI summaries |
| `GET  /api/zip-asset/<path>` | resolve a `file` field to a fetchable URL |
| `GET  /api/check-embeddable?url=` | X-Frame-Options / CSP pre-check before iframing |

Socket events from the server: `widget_state`, `widget_event`, `survey_response`.

Vendored libraries under `/static/vendor/`: `socket.io.min.js`, `qrcode.min.js`,
`pdfjs/pdf.min.mjs` + `pdf.worker.min.mjs`. Anything else comes from a CDN **with an
exact pinned version** (mathjs 11.11.0, marked 9.1.6, KaTeX 0.16.x, Pyodide 0.25.0,
Leaflet 1.9.4). Prefer a version a sibling widget already uses so a
deck downloads it once.

---

## 7. Code conventions

- **Section rulers**, sized to the file's density:
  `// ── Navigation ─────────────────────────────────────────────` or the
  `/* ══════ */` heavier bar in larger files. Mirror them in CSS with
  `/* ── Toolbar ─────── */`.
- **Comments explain why, not what.** The good ones in this codebase read like
  `// Never io() bare — inside the srcdoc iframe that resolves to …` or
  `// Fixed widths, not auto: every row is its own grid container, so content-sized
  columns would differ row to row and the addresses would stop lining up.`
  Write that kind. Delete restatements of the code.
- Aligned assignments and object literals where it makes a block scannable:
  ```js
  const canvas    = document.getElementById('plot-canvas');
  const coordDisp = document.getElementById('coord-display');
  ```
- `const` by default, `let` when reassigned. Arrow functions for callbacks, `function`
  declarations for top-level named behaviour.
- Optional chaining on everything from outside: `e.data?.type`, `player?.getCurrentTime?.()`.
- Swallow expected failures deliberately and say so: `catch (_) { /* cross-origin is normal */ }`.
  Never swallow a failure the presenter needs to see — surface it in the UI.
- Group DOM refs at the top, state in one object or a labelled block, then helpers,
  actions, events, config, boot. Boot is the last thing in the file.
- Ship an `escHtml()` helper and use it for **every** interpolation into `innerHTML`.
- Prefer `textContent` and `createElement` over `innerHTML` when the content is data.
- Cap unbounded growth: history 60–500 entries, transcript 400 rows.
- Use JSDoc on non-obvious functions in larger widgets (`cortexc.html` is the model).

### Avoid

- `localStorage` — `sessionStorage` only, and only where a reload must not lose a live
  poll; it is cleared on a genuine reload.
- Redefining host tokens in a new widget.
- Bare `io()`, unpinned CDN versions, icon fonts, frameworks.
- Blocking `alert()` / `confirm()`.
- Leaving a timer, rAF loop, socket, media stream or player alive after `widget-cleanup`.

---

## 8. Checklist before calling a widget done

- [ ] `widget-schema` block present, first in `<head>`, valid JSON, sensible category
- [ ] No `:root` token redefinitions; all colours/type/sizes come from base tokens
- [ ] `.bw-*` furniture used for toolbar, buttons, cards, spinner, empty states
- [ ] `applyConfig` is idempotent and handles being called again
- [ ] `widget-config`, `widget-cleanup`, `widget-get-state`, `widget-set-state` all handled
- [ ] Viewer role: every mutating path guarded, inputs disabled, badge shown
- [ ] Socket emission debounced; `io()` never called bare; `typeof io === 'undefined'` stub
- [ ] `getState()`/`applyState()` round-trip cleanly and are size-capped
- [ ] Cleanup tears down timers, rAF, sockets, streams, players
- [ ] Fills the iframe at both a wide and a narrow slide region; nothing scrolls `body`
- [ ] Works with the network absent, if the widget can (clear message, not a blank pane)

---

## 9. Starter template

Copy this and delete what the widget doesn't need.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<script id="widget-schema" type="application/json">
{
  "label": "Starter Widget",
  "category": "Tools",
  "fields": [
    { "key": "title",     "label": "Display title", "type": "text",     "placeholder": "Optional" },
    { "key": "autoStart", "label": "Start on open", "type": "checkbox", "default": false }
  ]
}
</script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Starter Widget — Beamer+</title>

<!-- Vendored by the Beamer+ server. Never load socket.io from a CDN, and never
     call io() bare — inside the srcdoc iframe that resolves to
     http://about/socket.io/, which an HTTPS deck blocks as mixed content. -->
<script src="/static/vendor/socket.io.min.js"></script>

<style>
/* Tokens, reset, toolbar, buttons, cards and the spinner come from the shared
   widget base (static/css/widget-base.css). What's left here is the one thing
   this widget owns. */

/* Revealed by the JS once there's something to act on, presenter only. */
#action-btn { display: none; }

#main-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px 24px 10%;   /* bias slightly above true centre */
  overflow: hidden;
  min-height: 0;
}

#readout {
  font-family: var(--font-mono);
  font-size: var(--fs-head);
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text);
  line-height: 1;
  user-select: none;
}

#caption { font-size: var(--fs-small); color: var(--text-3); text-align: center; }
</style>
</head>
<body>
<div id="shell" class="bw-shell">

  <div id="toolbar" class="bw-toolbar" data-bw-topbar>
    <span class="bw-toolbar-title" id="wtitle">Starter Widget</span>
    <div class="bw-sep"></div>
    <button class="bw-btn is-active" id="mode-a">Mode A</button>
    <button class="bw-btn"           id="mode-b">Mode B</button>
    <div class="bw-spacer"></div>
    <span id="status" class="bw-status">idle</span>
    <button class="bw-btn" id="reset-btn">Reset</button>
    <button class="bw-btn bw-btn--primary" id="action-btn">Start</button>
  </div>

  <div id="main-view">
    <div id="readout">0</div>
    <div id="caption" class="bw-hint">Press Start</div>
  </div>

</div>

<script>
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  const _qs       = new URLSearchParams(location.search);
  const CFG0      = window.WIDGET_CONFIG || {};
  let   cfg       = CFG0;
  let   WIDGET_ID = CFG0.id || CFG0.widgetId || 'starter-widget';
  let   role      = CFG0.role || 'presenter';
  let   IS_VIEWER = role === 'viewer' || _qs.get('viewer') === '1';

  // ── DOM ─────────────────────────────────────────────────────────────────────
  const titleEl   = document.getElementById('wtitle');
  const readout   = document.getElementById('readout');
  const caption   = document.getElementById('caption');
  const statusEl  = document.getElementById('status');
  const actionBtn = document.getElementById('action-btn');
  const resetBtn  = document.getElementById('reset-btn');
  const modeA     = document.getElementById('mode-a');
  const modeB     = document.getElementById('mode-b');

  // ── State ───────────────────────────────────────────────────────────────────
  // Everything that has to survive a re-render or travel to a viewer lives here
  // and nowhere else — the DOM is a projection of it, never the source.
  const S = { mode: 'a', count: 0, running: false };

  // ── Render ──────────────────────────────────────────────────────────────────
  function render() {
    readout.textContent  = String(S.count);
    caption.textContent  = S.running ? 'Running' : 'Press Start';
    statusEl.textContent = S.running ? 'running' : 'idle';

    modeA.classList.toggle('is-active', S.mode === 'a');
    modeB.classList.toggle('is-active', S.mode === 'b');

    actionBtn.textContent   = S.running ? 'Stop' : 'Start';
    actionBtn.style.display = IS_VIEWER ? 'none' : 'block';

    // A viewer watches; it never drives.
    [resetBtn, modeA, modeB].forEach(b => { b.disabled = IS_VIEWER; });
  }

  // ── Actions ─────────────────────────────────────────────────────────────────
  function setMode(m) {
    if (IS_VIEWER || S.mode === m) return;
    S.mode = m;
    render(); emitState();
  }

  function toggle() {
    if (IS_VIEWER) return;
    S.running = !S.running;
    render(); emitState();
  }

  function reset() {
    if (IS_VIEWER) return;
    S.count = 0; S.running = false;
    render(); emitState();
  }

  // ── Socket.IO sync ──────────────────────────────────────────────────────────
  // Presenter emits, viewers apply. Debounced so a drag or a keystroke burst
  // doesn't flood the room.
  let socket = null, syncTimer = null;

  function initSocket(url) {
    if (typeof io === 'undefined') { socket = { emit() {}, on() {} }; return; }
    try {
      const prev = socket;
      socket = io(url || (window.BeamerWidget ? BeamerWidget.serverOrigin() : ''),
                  { transports: ['websocket', 'polling'] });
      if (prev && prev.disconnect) prev.disconnect();
      socket.on('widget_state', data => {
        if (!IS_VIEWER || data?.widgetId !== WIDGET_ID) return;
        applyState(data.state || {});
      });
    } catch (_) {
      socket = { emit() {}, on() {} };
    }
  }

  function emitState() {
    if (!socket || IS_VIEWER) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      socket.emit('widget_state', { widgetId: WIDGET_ID, state: getState() });
    }, 120);
  }

  // ── State serialisation ─────────────────────────────────────────────────────
  // The same shape is used for live sync and for saving with the deck, so a
  // restored slide looks exactly like a synced viewer.
  function getState() {
    return { mode: S.mode, count: S.count, running: S.running };
  }

  function applyState(s) {
    if (!s) return;
    if (s.mode    != null) S.mode    = s.mode;
    if (s.count   != null) S.count   = s.count;
    if (s.running != null) S.running = s.running;
    render();
  }

  // ── Config ──────────────────────────────────────────────────────────────────
  function applyConfig(c) {
    if (!c) return;
    cfg       = { ...cfg, ...c };
    WIDGET_ID = cfg.id || cfg.widgetId || WIDGET_ID;
    role      = cfg.role || role;
    IS_VIEWER = role === 'viewer' || IS_VIEWER;

    if (cfg.title) titleEl.textContent = cfg.title;
    if (cfg.socketUrl) initSocket(cfg.socketUrl);
    if (cfg.autoStart && !IS_VIEWER && !S.running) S.running = true;

    render();
  }

  function destroy() {
    clearTimeout(syncTimer);
    if (socket && socket.disconnect) socket.disconnect();
    socket = null;
  }

  // ── Beamer+ message bridge ──────────────────────────────────────────────────
  window.addEventListener('message', e => {
    const d = e.data || {};
    if (d.type === 'widget-config')  applyConfig(d.config);
    if (d.type === 'widget-cleanup') destroy();
    if (d.type === 'widget-get-state') {
      window.parent.postMessage(
        { type: 'widget-state', widgetId: WIDGET_ID, state: getState() }, '*');
    }
    if (d.type === 'widget-set-state' && d.state) applyState(d.state);
  });

  // ── Event wiring ────────────────────────────────────────────────────────────
  actionBtn.addEventListener('click', toggle);
  resetBtn .addEventListener('click', reset);
  modeA    .addEventListener('click', () => setMode('a'));
  modeB    .addEventListener('click', () => setMode('b'));

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  initSocket(CFG0.socketUrl);
  applyConfig(CFG0);
  render();
})();
</script>
</body>
</html>
```

---

## 10. Patterns worth copying from the existing widgets

| Need | Look at |
|------|---------|
| Audience poll: QR → collect → results | `audience-response.html` (six question types, one widget) |
| Two-pane editor + output | `python-repl.html`, `cortexc.html` |
| Real REPL transcript with history, Tab completion, Ctrl+L/C | `python-shell.html` |
| Canvas with pan / wheel-zoom / pinch | `function-plotter.html`, `pdf.html` |
| Hover-reveal overlay control bar on media | `camera.html`, `youtube.html` |
| Third-party library themed to the deck via `!important` overrides | `map.html` (Leaflet) |
| Overlay states — placeholder / blocked / error with an escape action | `browser.html` |
| Boot state for a heavy runtime, plus a fatal banner | `python-shell.html` |
|                                                              |                                              |
