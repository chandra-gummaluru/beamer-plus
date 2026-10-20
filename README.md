# Beamer+

Beamer+ is a local, browser-based presentation tool for interactive lectures.
It renders PDF slide decks (e.g. LaTeX Beamer output) and layers live features
on top: pen and shape annotations, embedded video / audio / 3D models,
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

Open the `https://...` URL the launcher prints, then **Start a new session**
on the welcome screen (or go directly to `/s/{code}/` if you already have a
code). Browsers warn about the
self-signed certificate — click **Advanced → Proceed**. HTTPS is needed so
camera/microphone widgets work on LAN addresses.

For development there is a lighter entry point:

```bash
python app.py               # ad-hoc HTTPS cert (needs `cryptography`)
python app.py --http        # plain HTTP (camera widget disabled on LAN)
```

To try the built-in demo presentation (with a guided tour), click **Or open the
demo presentation** on the empty slide, or **Demo presentation** in the account
menu (top-right). The account button
(your GitHub name, or **Connect GitHub**) also changes the repository, signs you
out, and **Ends the session** (back to the start page).

## Loading a presentation

Click the empty slide, drag the file onto the window, or use **Open a presentation…** in the account menu (top-right, beside Save) to load either:

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

## Downloading

**Save** (top-right) offers two files to save to your computer, plus any screen
recordings (see Recording below). (Signed in with GitHub, Save puts them on GitHub
instead; see below.)

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

## GitHub (optional)

The welcome screen offers **Sign in with GitHub** or **Continue as guest**.
As a guest, Beamer+ works exactly as described above: files come from and go to
your computer. Signed in, it keeps your lectures in your GitHub course
repository: the same pair of repositories Lectern uses (e.g. `courses-utor`,
public with GitHub Pages, and `courses-utor-private`), though Beamer+ doesn't
need Lectern to do it.

- **Open a lecture** (click the empty slide, or the account menu, top-right).
  Signed in, presentations come from GitHub only: a file from your computer goes
  into a lecture first (**Add a deck** / **New lecture**). Pick a course offering (`csc258/f26`) and
  a lecture. A deck you've saved before shows **Resume** (it opens at the slide
  you were on) and **Start over** (the original, without your saved changes;
  those stay on GitHub until you next save). **Add a deck** / **New lecture**
  upload a PDF or ZIP from your computer into a lecture; **Open a file from this
  computer instead** works as before, without GitHub.
- **Save** (top-right) asks what to save to GitHub (the deck, the notes PDF,
  recordings); **Ctrl/⌘+S** saves straight away: the deck as it stands, with the
  slide you're on, and the notes PDF (on by default). When this lecture has new
  recordings, it asks which to upload (GitHub refuses files over 100 MB). A deck
  opened from your computer asks which lecture it belongs in first.

Where things go (one commit per repository per save):

```
courses-utor-private/                              (private)
  csc258/f26/lectures/05 - Binary Arithmetic/
    05 - Binary Arithmetic.zip          original (what Start over opens)
    05 - Binary Arithmetic.saved.zip    your last save (what Resume opens)
courses-utor/                                      (public, GitHub Pages)
  csc258/f26/slides/05 - Binary Arithmetic.pdf              notes PDF
  csc258/f26/recordings/05 - Binary Arithmetic - recording (2026-10-19 14-05).mp4
```

The notes and recordings land in the course offering's `slides/` and
`recordings/` folders of the public repository, so Lectern's course page can
pick and link them. A repository without a `-private` twin holds everything
(Beamer+ warns you if that one is public).

Tokens stay in the browser (for the tab only, unless **Keep me signed in on this
computer** is ticked); only the sign-in itself passes through the server.

### Setting up sign-in (one time, per server)

Beamer+ uses its own GitHub App (separate from Lectern's):

1. **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
   (<https://github.com/settings/apps/new>). Name it e.g. `Beamer+ UofT`.
2. **Homepage URL:** where Beamer+ runs, e.g. `https://beamer.changapp.net`.
3. **Callback URL:** `<that address>/api/github/callback`. Add one per address
   you open Beamer+ at (e.g. `https://localhost:5001/api/github/callback`, or
   the LAN address `launch.py` prints).
4. Leave **Expire user authorization tokens** ticked; leave **Request user
   authorization during installation** and **Device Flow** unticked; untick
   **Webhook → Active**.
5. **Repository permissions → Contents: Read and write.** Nothing else.
6. **Where can this GitHub App be installed? Any account.** Create it.
7. Copy the **Client ID**, generate a **client secret**, and note the app's
   address `github.com/apps/<slug>`.
8. Copy `.env.example` to `.env` beside `app.py` and fill in
   `BEAMER_GH_CLIENT_ID`, `BEAMER_GH_CLIENT_SECRET` and `BEAMER_GH_APP_SLUG`
   (`BEAMER_APP_URL` too if the server sits behind another address). `.env` is
   git-ignored. Both `app.py` and `launch.py` read it.
9. **Install App** on your account, with access to your course repository and
   its `-private` twin. Beamer+'s repository chooser links here too.

`tests/browser/flow_github.py` walks through all of this against a fake GitHub.

## Recording

The record button (bottom-right, next to the hide-slide button) records this
tab — slides, ink and widgets — as a video, with your microphone and/or the
tab's sound (videos, audio, widgets). While recording, the button turns into a
small bar with the time, pause / resume and stop. Stop and start again as often
as you like — every take is kept and offered when you **Save**, where
each can be downloaded (MP4 in Chrome/Edge, WebM elsewhere) or deleted.

Takes are saved to the browser's storage (IndexedDB) a second at a time, so a
reload or crash doesn't lose them; they stay until you delete them. Recording
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
slides. Built-ins include a browser, calculator, camera, circuit sandbox,
function plotter, Jupyter-notebook runner, map, an audience-response panel (multiple choice, true/false, rating, numeric estimate, word cloud, open-ended),
PDF textbook viewer, Python workspace, Python shell, terminal, timer, and YouTube player.
A widget is shown either full (the whole slide) or, if it supports it, as an
overlay — a small box over part of a content slide, with no bar (the timer,
calculator and Python shell do).

To add your own, drop an `.html` file in `widgets/`. A `<script
id="widget-schema" type="application/json">` block in the file describes the
editable fields the editor shows for it, and widgets can sync state across
instances by emitting `widget_state` over Socket.IO. A widget can also say how it appears in
the notes PDF by registering a print handler (`BeamerWidget.print.register`; see
`bpwidget-skill.md`).

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
│   ├── state.py            #   in-memory shared state (surveys, presentation)
│   ├── ai_models.py        #   survey-summarization model loading
│   ├── pages.py            #   HTML pages + PWA files
│   ├── presentation.py     #   upload, ZIP assets, demo packaging
│   ├── widgets.py          #   widget serving, embeddability probe
│   ├── surveys.py          #   survey REST API
│   └── sockets.py          #   Socket.IO handlers
├── ai/                     # built-in survey-summarization models (plugin dir)
├── templates/              # audience-facing pages + presenter shell
├── static/
│   ├── css/                # tokens → base → components/ → features/
│   ├── js/
│   │   ├── main.js         #   orchestrator: state, navigation, rendering
│   │   ├── core/           #   event bus, canvas, modal, widget iframes
│   │   ├── slides/         #   navigator, thumbnails, structure, media, spotlight
│   │   ├── annotations/    #   toolbar, pen slots, shape tools
│   │   ├── app/            #   settings, help, tour, uploader
│   │   └── editor/         #   edit mode (overlays, properties, picker, save)
│   └── vendor/             # vendored third-party libraries (no CDN)
├── widgets/                # built-in widget HTML files (one file per widget)
├── demo/                   # bundled demo presentation (used by the tour)
├── tests/                  # pytest suite for the Flask API
├── manifest.json           # PWA manifest (served from /manifest.json)
└── service-worker.js       # PWA service worker (served from /)
```

## Development

```bash
pip install -r requirements-dev.txt
pytest
```

Third-party frontend libraries are vendored in `static/vendor/` so the app
has no CDN dependency and works offline (some widgets still pull large
optional libraries, e.g. Pyodide, from CDNs). The app is an installable PWA;
bump the cache version in `service-worker.js` when changing static assets.

## License

MIT — see [LICENSE](LICENSE).
