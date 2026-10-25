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
- **A presentation ZIP** — a PDF plus saved configuration, media, widgets and
  AI models (see below). The in-app editor can add media/widgets to slides and
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
├── assets/ video/ models/ …    # media referenced by the configs
└── ai/
    └── <model>.py              # optional survey-summarization models (see below)
```

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
  key in the widget settings; requires `pip install anthropic`)
- `gpt4o` — uses the OpenAI API (`OPENAI_API_KEY`; requires `pip install openai`)

### Custom models

Drop a Python file in `ai/` (server-wide) or inside a presentation ZIP under
`ai/`. It must expose:

```python
def summarize(responses: list[str], n: int, api_key: str | None = None):
    """Return a list of exactly n (summary_text, num_respondents) tuples."""
```

## Widgets

Widgets are standalone HTML files in `widgets/`, rendered in iframes on
slides. Built-ins include a calculator, camera, circuit sandbox, function
plotter, Jupyter-notebook runner, map, an audience-response panel (multiple
choice, true/false, rating, numeric estimate, word cloud, open-ended), PDF
textbook viewer, Python workspace, Python shell, randomizer, table, terminal,
timer, and YouTube player.
A widget is shown either full (the whole slide) or, if it supports it, as an
overlay — a small box over part of a content slide, with no bar (the timer,
calculator and Python shell do).

To add your own, drop an `.html` file in `widgets/`. A `<script
id="widget-schema" type="application/json">` block in the file describes the
fields edited from the pencil on the widget while presenting (the editor
panel only holds its name, text size and position). The settings kit
(`static/js/widget-settings-kit.js`) is injected into every widget and gives
it the `BeamerWidget` API; a widget can say how it appears in the notes PDF by
registering a print handler (`BeamerWidget.print.register`).

## Security model

Beamer+ assumes a **cooperative local network** (a lecture hall, not the open
internet):

- Loading a presentation ZIP **executes any `ai/*.py` inside it** — only open
  ZIPs you trust.
- Socket.IO accepts connections from any origin so widget iframes and audience
  devices can connect.
- The TLS certificate is self-signed (`cert.pem` / `key.pem`, regenerated by
  `launch.py`; delete them to force regeneration).

Do not expose the server to the public internet.

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
```

Third-party frontend libraries are vendored in `static/vendor/` so the app
works offline (some widgets still pull large optional libraries, e.g.
Pyodide, from CDNs).

## License

MIT — see [LICENSE](LICENSE).
