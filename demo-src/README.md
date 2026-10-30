# Demo deck source

`demo.tex` builds `demo/slides.pdf`, the deck behind **Try Demo**.

    cd demo-src
    pdflatex demo.tex && pdflatex demo.tex   # twice: pictures are placed on the page
    cp demo.pdf ../demo/slides.pdf

It was rebuilt from the compiled PDF after the original source was lost. The
slides are laid out on fixed page coordinates (pt from the top-left corner),
because the demo's config in `demo/config/` places videos, 3D models, widgets,
reveal boxes and saved ink by position on the page: move something on a slide
and check what sits on it in `demo/config/s<page-1>.json`.

`img/` holds the two hand-drawn arrows.
