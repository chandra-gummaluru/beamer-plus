# Beamer+

Beamer+ is a local, browser-based presentation tool for interactive lectures.
It renders PDF slide decks (e.g. LaTeX Beamer output) and layers live features
on top: pen and highlighter annotations (draw and hold to snap a shape), embedded video / audio / 3D models,
interactive widgets (calculators, plotters, Python REPLs, maps, …), and
real-time audience surveys with AI-powered response summarization.

Everything runs from a single Flask server — on your machine for solo use, or
hosted by your university for multiple concurrent lectures. Each presenter
creates a **session** and works at `/s/{code}/`; audience survey QR codes
point to URLs under that same session prefix.

## Quick start

Requires Python 3.10+.

```bash
pip install -r requirements.txt
python launch.py            # production launcher: HTTPS with a self-signed cert
```

Open the `https://...` URL the launcher prints, then **New Session** on the
welcome screen (or **Try Demo**; or go directly to `/s/{code}/` if you
already have a code). Browsers warn about the
self-signed certificate — click **Advanced → Proceed**. HTTPS is needed so
camera/microphone widgets work on LAN addresses.

For development there is a lighter entry point:

```bash
python app.py               # ad-hoc HTTPS cert (needs `cryptography`)
python app.py --http        # plain HTTP (camera widget disabled on LAN)
```

To try the built-in demo presentation (with a guided tour), click **Try
Demo** on the welcome screen.

## Loading a presentation

A new session starts with the **Open** window (see below); you can also drag
a file onto the window. Either way, load:

- **A plain PDF** — every page becomes a slide.
- **A presentation ZIP** — a PDF plus saved configuration, media and widgets
  (see below). The in-app editor can add media/widgets to slides and
  save the result back out as a ZIP.

### Presentation ZIP format

```
presentation.zip
├── slides.pdf                  # required — the slide deck
├── config/
│   ├── slide-order.json        # slide sequence: pdf pages, blank slides, split views, hidden flags
│   ├── s<N>.json               # per-slide config: embedded videos/audio/models/widgets + layout
│   ├── annotations.json        # saved pen strokes per slide
│   └── widget-states.json      # widget state snapshots so widgets resume where they left off
└── assets/ video/ models/ …    # media referenced by the configs
```

An `ai/` folder in a ZIP (older decks may have one) is ignored: opening a
deck never runs code from it. Summarizer models live on the server (see
Custom models).

## What Save writes

Save (see below) can write two files, plus any screen recordings:

- **Presentation (ZIP)** — everything above, to reopen and keep presenting.
- **Notes (PDF)** — one flat PDF to hand out. Every visible slide (hidden and
  split-view slides are skipped) with pen annotations drawn on; each widget as it
  stands at that moment; videos as a still frame, 3D models as a rendered picture,
  audio as a labelled bar; and poll results. A widget can add pages of its own
  right after its slide (the circuit sandbox prints its board; the notebook prints every cell; the Python workspace
  prints its program, shell transcript and memory diagram; an open-ended poll
  lists every answer). Widgets that don't describe how to print appear as a labelled
  placeholder box. Built in the browser with pdf-lib; PDF slides are copied as
  vector pages, so their text stays selectable.

## Sessions

The welcome screen offers **New Session** (the Open window comes up, and
stays until a presentation is open) and **Try Demo** (the demo presentation
with a guided tour).

Two buttons top-right run the session: **Edit** (once a presentation is open)
and **Close Session**, which asks whether to save first, then goes back to
the start page.

## Opening and saving: folders on this computer

Open and Save work like a file manager, each on a folder you choose once:
the folder you open presentations from, and the folder you save them in
(your course folder for both, say, or two different ones; the first time,
Save offers **Use <the Open folder>** as a one-click choice). Both are
remembered across sessions, along with the subfolder you were last in; after
the browser restarts it asks once to allow each again (Chrome's **Allow on
every visit** skips that). Beamer+ doesn't impose a layout: you choose where
things go. **Change folder…** picks another. Underneath, **Or upload from somewhere else
instead** (Open) is the system file picker, and **Or download instead**
(Save) saves to your browser's downloads folder.

- **Open** lists the folders and the `.zip` / `.pdf` files in the one you're
  in; click one to open it. Dropping a file on the window opens one too.
- **Save** (from Close Session) starts where the presentation was last saved (or the
  folder it was opened from, when that's inside the save folder), otherwise
  where you last saved. Pick a
  folder, a file name, and tick what to save (Presentation, Notes,
  Recordings); each goes in that folder:
  - `<name>.zip`: the presentation, which reopens at the slide you were on
  - `<name>.pdf`: the notes PDF (so don't name it after a slides PDF in the same
    folder, or the notes replace it)
  - `<name>-<yyyy-mm-dd>-<hh-mm>[-part<n>].mp4` (or `.webm`): recordings not
    saved yet

Choosing a folder needs the File System Access API (Chrome, Edge). In other
browsers Open is the file picker and Save downloads.

`tests/browser/flow_sessions.py` walks through all of this.

## Recording

The record button (bottom-right) records this
tab — slides, ink and widgets — as a video, with your microphone and/or the
tab's sound (videos, audio, widgets). While recording, the button turns into a
small bar with the time, pause / resume and stop. Stop and start again as often
as you like — every take is kept and offered when you **Save** (MP4 in
Chrome/Edge, WebM elsewhere); one too big for the folder is downloaded instead.

Takes are saved to the browser's storage (IndexedDB) a second at a time, so a
reload or crash doesn't lose them. Recording
needs a secure context (the `https://` address, or `localhost`).

## Surveys

Survey widgets generate a QR code that audience members scan to answer from
their phones (open text, word cloud, or multiple choice). Responses stream
back live over Socket.IO. Open-text responses can be clustered into thematic
summaries by an AI model.

Two models ship built in:

- `claude` — uses the Anthropic API (`ANTHROPIC_API_KEY` env var, or paste a
  key in the widget settings; requires `pip install anthropic`). A key pasted
  in the widget is kept in that browser only, never saved in the deck.
- `gpt4o` — uses the OpenAI API (`OPENAI_API_KEY`; requires `pip install openai`)

### Fill in the blanks

Blanks are written in the question, in prose or inside a code block:

| Written | On the phone |
|---|---|
| `BLANK` or `___` | a text box (written as underscores, it's as wide as they are) |
| `BLANK(True ^ False)` | pick exactly one (`XOR` works too) |
| `BLANK(a \| b \| c)` | pick any number, as checkboxes (`OR` works too) |

With the results up, the slide shows one student's whole answer at a time —
typed answers and picked options highlighted — and the arrows (or ← →) step
through the class. Put `*` before the right option(s), as in
`BLANK(True ^ *False)`, and the poll gets a **Reveal answer** step that ticks
them. The edit bar's **Insert blank** buttons write these for you.

### Content filter

Free-text answers (open text, word cloud, fill in the blanks) are checked on
the server before they're stored or shown. A rejected answer never reaches the
slide; the student is told it may contain inappropriate language and can
rephrase it. Everything runs on this computer.

- **Word list** (`better-profanity`, in `requirements.txt`): swear words,
  including leetspeak. Each question has its own settings in the widget's
  edit bar (**Filter**): on/off, an **Allow** list (words never to flag, e.g.
  course terms) and a **Block** list (extra words or phrases), comma-separated.
  The lists are saved with the slide and never sent to phones.
- **Toxicity model** (optional, `pip install detoxify` — large, needs
  PyTorch): also catches insults and threats without swear words. Loads in
  the background at startup; the first run downloads the model.
  `BEAMER_TOXICITY_THRESHOLD` (default `0.8`) sets how strict it is.
- `BEAMER_CONTENT_FILTER=off` turns it off on this machine for every question.

### Custom models

Drop a Python file in the server's `ai/` folder. It must expose:

```python
def summarize(responses: list[str], n: int, api_key: str | None = None):
    """Return a list of exactly n (summary_text, num_respondents) tuples."""
```

## Widgets

Widgets are standalone HTML files in `widgets/`, rendered in iframes on
slides. Built-ins include a calculator, camera, circuit sandbox, function
plotter, Jupyter-notebook runner, map, an audience-response panel (multiple
choice, true/false, rating, numeric estimate, numerical answer, word cloud,
fill in the blanks, 2D plot, open-ended), PDF textbook viewer, Python
workspace, randomizer, terminal, timer, and YouTube player.
A widget is shown either full (the whole slide) or, if it supports it, as an
overlay — a small box over part of a content slide, with no bar (the timer,
calculator and function plotter do).

A widget's own settings are the widget's business: Beamer+ edits only what
every widget shares — its name, text size and place on the slide (the
editor panel). A widget with settings declares `"inlineEdit": true` and is
set up on itself: the Edit button in its top-right corner puts it into edit
mode, where its own content is the form — the timer's digits are its
duration, the poll's question and answers are typed where they show — and
`BeamerWidget.edit.set()` saves each change with the slide. A widget without
it (the calculator, the circuit sandbox) has nothing to set up and no Edit
button.

To add your own, drop an `.html` file in `widgets/`. A `<script
id="widget-schema" type="application/json">` block in the file describes it:

```json
{ "label": "My Widget", "category": "Tools", "inlineEdit": true,
  "modes": ["full", "overlay"], "overlaySize": { "width": 0.3, "height": 0.3 } }
```

`label` and `category` place it in the widget picker; `modes` (or
`"fullSlide": true`) say how it can be shown; `"fontSize": false` opts out
of the text-size control and `"scale"` sets its default. The settings kit
(`static/js/widget-settings-kit.js`) gives every widget the `BeamerWidget`
API (its config, edit mode, saving files into the deck) and the shared top
bar; a widget can say how it appears in the notes PDF by registering a print
handler (`BeamerWidget.print.register`).

### Split widgets

A split view can hold one widget that spans both of its slides: the Python
workspace puts its editor on the left slide and its shell, memory model or
debugger on the right (tabs on the right half switch between them during the
lecture). Add one from the split view's panel in the editor (**Split Widget**).
It is one widget with one iframe, saved in the view's own config
(`config/sv<viewId>.json`): it works only while both slides are on screen,
each in its own pane; a slide shown on its own shows its half as it was left,
not clickable. Deleting it removes both halves.

A widget opts in with `"split": { "left": [...], "right": [...] }` in its
schema (which panes may go on each side). The host lays the iframe over both
slides, clipped to them, and tells the widget where each half is:
`{ type: 'widget-split', live, left: {x, y, w, h} | null, right: … }` in the
iframe's own pixels (`static/js/slides/split-widgets.js`).

Every widget is self-contained, so it also works opened straight from disk:
`python tools/stamp_widgets.py` copies the current `widget-base.css` and kit
into each file in `widgets/` (re-run it after changing either; a test fails
when a copy is stale). Opened on its own, edits last until the page reloads.

## Security model

The session code is public — it is in every audience link and QR code — so it
only gets you the audience side: the question pages and sending one answer.

- **Presenter token.** Creating a session sets a secret, HttpOnly cookie in
  that browser. Everything else needs it: the presenter view, opening a deck,
  the deck's files, starting / closing polls, reading answers, AI summaries,
  and the socket room the answers arrive in. Presenter POSTs must also come
  from this server's own pages (Origin / Sec-Fetch-Site), so a page elsewhere
  on the same domain can't send them with the presenter's cookie. A session
  belongs to the browser that started it; to present from another one, start
  a new session there.
- **No code from decks.** An uploaded ZIP's `ai/*.py` is never run;
  summarizer models come only from the server's `ai/` folder.
- **Secrets stay out of decks.** An AI key typed into the audience-response
  widget lives in that browser's storage; Save strips any `apiKey` from the
  deck (older decks carried one — save them again, and rotate the key if a
  deck with one in it was shared).
- **Deck files can't act as pages.** Files served from a deck or uploaded in
  the editor carry `Content-Security-Policy: sandbox` and `nosniff`.
  Widgets themselves are code: they run in same-origin iframes with the
  presenter's rights (the app's API, and AI keys kept in this browser), so
  only open decks with custom widgets from people you trust.
- **Audience limits.** One answer per phone per question (an anonymous
  cookie). Answers go to the presenter only, not to the other phones.
- **Resource limits.** Requests up to `BEAMER_MAX_UPLOAD_MB` (1024);
  files uploaded from the editor up to `BEAMER_MAX_TEMP_ASSETS_MB` (256) per
  session and `BEAMER_MAX_TEMP_ASSETS_TOTAL_MB` (1024) across sessions; deck
  files are streamed, never inflated whole. A session with no presenter
  activity for `BEAMER_SESSION_IDLE_HOURS` (24) is removed with its deck (an
  open presenter tab keeps it alive), one that never got a deck after
  `BEAMER_EMPTY_SESSION_MINUTES` (60), and Close session removes one at
  once. At most `BEAMER_MAX_SESSIONS` (200) at a time,
  `BEAMER_MAX_LIVE_SESSIONS_PER_IP` (10) per address and
  `BEAMER_MAX_SESSIONS_PER_IP_PER_HOUR` (30) new ones per address. At
  startup, `app.py` / `launch.py` delete session folders in `uploads/`
  older than the idle limit.
- **Answer keys stay with the presenter.** The `*` marking a right option in
  a fill-in-the-blanks template is removed before phones get it.
- **Sockets** accept only this server's own pages. Behind a proxy with a
  different public address, list it in `BEAMER_ALLOWED_ORIGINS`.
- The TLS certificate is self-signed (`cert.pem` / `key.pem`, regenerated by
  `launch.py`; delete them to force regeneration; the key is written
  owner-only).

Optional: `BEAMER_MAX_RESPONSES_PER_IP` caps answers per network address per
question, against a script that clears its cookie. It's off by default since a
whole class behind one NAT or proxy shares an address.

There are no user accounts: anyone who can reach the server can start a
session. Keep it on the campus network rather than the open internet.

## Project layout

```
beamer-plus/
├── app.py                  # dev entry point (`python app.py`)
├── launch.py               # production launcher: HTTPS cert + startup info
├── server/                 # backend (Flask) — one module per concern
│   ├── core.py             #   Flask app + Socket.IO instances
│   ├── paths.py            #   BASE_PATH and derived folders
│   ├── env.py              #   .env loading
│   ├── sessions.py         #   presenter sessions and their state
│   ├── state.py            #   survey limits (re-exported for the tests)
│   ├── ai_models.py        #   survey-summarization model loading
│   ├── pages.py            #   HTML pages, manifest, service-worker tombstone
│   ├── presentation.py     #   upload, ZIP assets, demo packaging
│   ├── widgets.py          #   widget serving and catalog
│   ├── surveys.py          #   survey REST API
│   └── sockets.py          #   Socket.IO handlers
├── ai/                     # built-in survey-summarization models (plugin dir)
├── templates/              # audience-facing pages + presenter shell
├── static/
│   ├── css/                # tokens → base → components/ → features/ (see Design below)
│   ├── js/
│   │   ├── main.js         #   orchestrator: state, navigation, rendering
│   │   ├── core/           #   event bus, canvas, modal, widget iframes
│   │   ├── slides/         #   navigator, thumbnails, structure, media, spotlight
│   │   ├── annotations/    #   toolbar, pen slots, text boxes
│   │   ├── app/            #   session buttons, recorder, tour, uploader
│   │   ├── library/        #   Open and Save: folders on this computer
│   │   └── editor/         #   edit mode (overlays, properties, picker, save)
│   └── vendor/             # vendored third-party libraries (no CDN)
├── widgets/                # built-in widget HTML files (one file per widget)
├── demo/                   # bundled demo presentation (used by the tour)
├── tests/                  # pytest suite (API) + browser walkthroughs (tests/browser)
├── manifest.json           # web app manifest (served from /manifest.json)
└── service-worker.js       # tombstone: unregisters an old caching worker
```

## Design

Every colour, type size, spacing, radius and shadow comes from
`static/css/tokens.css`; feature CSS lays things out but never types a value
of its own. Controls are one of a few shared components:

- **Buttons** (`components/button.css`): `.btn`, with `--primary` (the one
  main action), `--ghost` (toolbars, ×), `--danger`, `--sm` (editor panel and
  sheets) and `--icon`; `.btn_selected` for a toggle that is on; `.link` for
  a quiet text action.
- **Fields** (`components/field.css`): `.field` for text boxes, text areas and
  selects; in the editor, selects become the custom dropdown
  (`editor/dropdown.js`).
- **Dialogs** (`components/modal.css`, `core/modal.js`): one shell; title and
  message left-aligned, buttons right-aligned with the main action last.
- **Copy**: Title Case for buttons, titles, tooltips and field labels;
  sentence case for messages and hints.

## Development

```bash
pip install -r requirements-dev.txt
pytest
python tests/browser/flow_sessions.py   # with the app running on :5001 (--http)
python tests/browser/flow_security.py   # presenter / audience split, same server
```

Third-party frontend libraries are vendored in `static/vendor/` so the app
works offline (some widgets still pull large optional libraries, e.g.
Pyodide, from CDNs).

## License

MIT — see [LICENSE](LICENSE).
