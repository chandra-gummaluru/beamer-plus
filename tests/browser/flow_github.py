"""Walk through Beamer+'s GitHub features against a fake GitHub (fakegh.py).

  python app.py --http --port 5001        (in another terminal)
  python tests/browser/flow_github.py     screenshots land in tests/browser/shots/

Needs Playwright (pip install playwright; playwright install chromium).
"""
import io
import json
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(__file__))
from playwright.sync_api import sync_playwright  # noqa: E402
from fakegh import FakeGitHub, Repo  # noqa: E402

BASE = os.environ.get("BEAMER_URL", "http://localhost:5001/")
OUT = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(OUT, exist_ok=True)
L = "csc258/f26/lectures/05 - Binary Arithmetic"


def make_pdf(pages=6, title="Binary Arithmetic"):
    """A tiny PDF without extra libraries: one line of text per page."""
    objs, kids = [], []
    font = 3
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(None)                                   # pages, filled below
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
    for i in range(pages):
        text = f"BT /F1 24 Tf 30 140 Td ({title} - slide {i + 1}) Tj ET".encode()
        objs.append(b"<< /Length %d >>\nstream\n" % len(text) + text + b"\nendstream")
        content = len(objs)
        objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 363 272] /Contents %d 0 R /Resources << /Font << /F1 %d 0 R >> >> >>" % (content, font))
        kids.append(len(objs))
    objs[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), pages)
    out, offs = io.BytesIO(), []
    out.write(b"%PDF-1.4\n")
    for n, o in enumerate(objs, 1):
        offs.append(out.tell())
        out.write(b"%d 0 obj\n" % n + o + b"\nendobj\n")
    x = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for o in offs:
        out.write(b"%010d 00000 n \n" % o)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x))
    return out.getvalue()


def make_zip(pdf):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("slides.pdf", pdf)
    return b.getvalue()


def make_gh():
    gh = FakeGitHub()
    gh.add(Repo("chandra-gummaluru/courses-private", True, {
        "csc258/f26/grades.json": "{}",
        f"{L}/05 - Binary Arithmetic.zip": make_zip(make_pdf()),
        "csc258/f26/lectures/06 - Multiplication/06 - Multiplication.pdf": make_pdf(4, "Multiplication"),
        "csc108/w26/grades.json": "{}",
    }))
    gh.add(Repo("chandra-gummaluru/courses", False, {"README.md": "x", "csc258/f26/info.html": "<p>x</p>"}))
    gh.add(Repo("chandra-gummaluru/sandbox", False, {"README.md": "x"}))
    return gh


SIGN_IN = """() => sessionStorage.setItem('beamer.github', JSON.stringify({access_token:'tok', refresh_token:'r', expires_at: Date.now()+8*3600e3}))"""
FAKE_TAKE = """async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('beamer-recordings', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('meta', {keyPath:'id'}); r.result.createObjectStore('chunks', {autoIncrement:true}).createIndex('recId','recId'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction(['meta','chunks'], 'readwrite');
  const now = Date.now();
  tx.objectStore('meta').put({ id:'rec-1', sessionId:'X', deckName:'05 - Binary Arithmetic', label:'Recording 1',
    fileName:'05 - Binary Arithmetic - recording 1 (x).webm', mimeType:'video/webm', startedAt: now - 60000, durationMs: 42000,
    size: 11, status:'done', lecture:'csc258/f26/05 - Binary Arithmetic' });
  tx.objectStore('chunks').add({ recId:'rec-1', seq:0, blob: new Blob(['hello video'], {type:'video/webm'}) });
  await new Promise(r => tx.oncomplete = r);
}"""


def run():
    gh = make_gh()
    priv, pub = gh.repos["chandra-gummaluru/courses-private"], gh.repos["chandra-gummaluru/courses"]
    errors, checks = [], []

    def check(name, ok):
        checks.append((name, bool(ok)))
        print(("PASS " if ok else "FAIL ") + name)

    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1360, "height": 860})
        ctx.route("https://api.github.com/**", gh.handle)
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        shot = lambda n: page.screenshot(path=f"{OUT}/{n}.png")
        st = lambda expr: page.evaluate(f"() => {{ const s = window.beamerState || {{}}; return s.{expr}; }}")

        # 1. Welcome page, signed out, then signed in.
        page.goto(BASE); page.wait_for_timeout(700); shot("01-welcome")
        check("welcome offers sign-in", "Sign in with GitHub" in page.inner_text("#welcome-github-btn"))
        check("welcome offers guest, no tour", page.locator("#welcome-create-btn").is_visible() and page.locator("#welcome-tour-btn").count() == 0)
        page.evaluate(SIGN_IN); page.reload(); page.wait_for_timeout(800); shot("02-welcome-signed-in")
        check("welcome shows who is signed in", "chandra-gummaluru" in page.inner_text("#welcome-account")
              and "Start a session" in page.inner_text("#welcome-github-btn"))

        # 2. Continue → session; the library opens by itself; choose the repository.
        page.click("#welcome-github-btn"); page.wait_for_url("**/s/**"); page.wait_for_timeout(3200); shot("03-repo-picker")
        check("asks for the repository", page.locator(".gh-lib [data-repo]").count() == 1)
        page.select_option(".gh-lib select[data-repo]", "chandra-gummaluru/courses"); page.wait_for_timeout(200)
        page.click("[data-use]"); page.wait_for_timeout(1200); shot("04-library")
        check("lists lectures", page.locator(".gh-lecture").count() == 2)

        # 3. Open the lecture's deck (no save yet: just Open).
        page.click(".gh-lecture[data-i='0'] [data-orig]"); page.wait_for_timeout(2500)
        check("deck opened with its lecture", st("ghTarget && s.ghTarget.lecture") == "05 - Binary Arithmetic")
        check("deck name", st("deckName") == "05 - Binary Arithmetic")
        for _ in range(3):
            page.keyboard.press("ArrowRight"); page.wait_for_timeout(350)
        check("on slide 4", st("currentSlide") == 3)
        shot("05-opened")

        # 4. Save dialog from the download button, with a recording to pick.
        page.evaluate(FAKE_TAKE)
        page.click("#account-btn"); page.wait_for_timeout(300); shot("06-account-menu")
        check("account menu: open, demo, change repo, sign out, end",
              [b.get_attribute("data-menu") for b in page.locator(".account-menu [data-menu]").all()] == ["open", "demo", "repo", "out", "end"])
        check("account button shows the GitHub login", "chandra-gummaluru" in page.inner_text("#account-btn"))
        page.keyboard.press("Escape")
        page.click("#save-btn"); page.wait_for_timeout(900); shot("07-save-dialog")
        check("save dialog asks what to save", page.locator("[data-deck]").is_checked() and page.locator("[data-notes]").count() == 1)
        check("recording offered and ticked", page.locator("[data-rec='rec-1']").is_checked())
        page.click(".custom-modal-btn-ok"); page.wait_for_timeout(6000); shot("08-saved")
        pf, uf = priv.files(), pub.files()
        saved = pf.get(f"{L}/05 - Binary Arithmetic.saved.zip")
        check("saved zip in private repo", saved is not None)
        if saved:
            resume = json.loads(zipfile.ZipFile(io.BytesIO(saved)).read("config/resume.json"))
            check("resume point is slide 4", resume.get("slide") == 3)
        check("notes PDF in public repo", uf.get("csc258/f26/slides/05 - Binary Arithmetic.pdf", b"")[:5] == b"%PDF-")
        recs = [k for k in uf if k.startswith("csc258/f26/recordings/05 - Binary Arithmetic - recording (")]
        check("recording in public repo", len(recs) == 1 and uf[recs[0]] == b"hello video")
        check("nothing private leaked to public", not any(k.endswith(".zip") for k in uf))

        # 5. Ctrl+S quick save after moving on.
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(400)
        n = len(priv.commits)
        page.keyboard.press("Control+s"); page.wait_for_timeout(5000)
        check("Ctrl+S committed", len(priv.commits) == n + 1)
        resume = json.loads(zipfile.ZipFile(io.BytesIO(priv.files()[f"{L}/05 - Binary Arithmetic.saved.zip"])).read("config/resume.json"))
        check("resume point moved to slide 5", resume.get("slide") == 4)

        # 6. A new session: Resume opens where we left off; Start over opens the original.
        page.goto(BASE); page.wait_for_timeout(600)
        page.click("#welcome-github-btn"); page.wait_for_url("**/s/**"); page.wait_for_timeout(3500)
        page.wait_for_timeout(800); shot("09-library-resume")
        check("Resume offered", page.locator(".gh-lecture[data-i='0'] [data-resume]").count() == 1)
        page.click(".gh-lecture[data-i='0'] [data-resume]"); page.wait_for_timeout(3000)
        check("resumed at slide 5", st("currentSlide") == 4)
        page.click("#account-btn"); page.click(".account-menu [data-menu='open']"); page.wait_for_timeout(1200)
        page.click(".gh-lecture[data-i='0'] [data-orig]"); page.wait_for_timeout(3000)
        check("start over at slide 1", st("currentSlide") == 0)
        shot("10-start-over")

        # 7. A new lecture with a deck from this computer, in a new course offering.
        page.click("#account-btn"); page.click(".account-menu [data-menu='open']"); page.wait_for_timeout(1200)
        page.select_option(".gh-lib select[data-off]", "__new")
        page.fill("[data-c]", "csc258"); page.fill("[data-t]", "w27"); page.click("[data-make-off]"); page.wait_for_timeout(300)
        page.fill("[data-name]", "01 - Intro"); shot("11-new-lecture")
        pdf = os.path.join(OUT, "intro.pdf")
        with open(pdf, "wb") as f:
            f.write(make_pdf(3, "Intro"))
        with page.expect_file_chooser() as fc:
            page.click("[data-new-file]")
        fc.value.set_files(pdf); page.wait_for_timeout(3000)
        check("original uploaded to new lecture", "csc258/w27/lectures/01 - Intro/intro.pdf" in priv.files())
        check("new deck has its lecture", st("ghTarget && s.ghTarget.lecture") == "01 - Intro")
        shot("12-new-lecture-open")

        # 8. Signed in, a dropped file doesn't open by itself: the library opens.
        page.evaluate("""() => { const dt = new DataTransfer(); dt.items.add(new File(['%PDF-1.4'], 'dropped.pdf', {type:'application/pdf'}));
            for (const t of ['dragenter','dragover','drop']) window.dispatchEvent(new DragEvent(t, {dataTransfer: dt, bubbles: true, cancelable: true})); }""")
        page.wait_for_timeout(1200)
        check("drop while signed in opens the library", page.locator(".gh-lib").count() == 1 and st("deckName") == "intro")
        check("library has no open-from-computer link", page.locator("[data-local]").count() == 0)
        page.keyboard.press("Escape"); page.mouse.click(5, 5); page.wait_for_timeout(300)
        page.evaluate("window.BeamerModal && window.BeamerModal.close()")
        # A deck from elsewhere (the demo, say) asks which lecture on its first save.
        page.set_input_files("#upload-presentation", pdf); page.wait_for_timeout(2500)
        check("local deck has no lecture", not st("ghTarget"))
        page.keyboard.press("Control+s"); page.wait_for_timeout(1500); shot("13-save-where")
        page.select_option(".gh-lib select[data-off]", "csc258/f26"); page.wait_for_timeout(800)
        page.click(".gh-lecture[data-i='1'] [data-save-here]"); page.wait_for_timeout(600)
        page.click(".custom-modal-btn-ok"); page.wait_for_timeout(5000)
        pf = priv.files()
        check("original and saved copy added", "csc258/f26/lectures/06 - Multiplication/intro.pdf" in pf and
              "csc258/f26/lectures/06 - Multiplication/intro.saved.zip" in pf)
        check("notes named for lecture + deck", "csc258/f26/slides/06 - Multiplication - intro.pdf" in pub.files())

        # 9. Demo presentation from the library: loads the demo deck and starts the tour.
        page.click("#account-btn"); page.click(".account-menu [data-menu='open']"); page.wait_for_timeout(1200)
        page.click("[data-demo]"); page.wait_for_timeout(12000); shot("14-demo-tour")
        check("demo deck loaded", st("deckName") == "demo")
        check("tour running", "1 of" in page.inner_text("body"))

        # Signing out in a session: the deck stays open; the account button becomes Connect GitHub.
        page.get_by_text("Skip", exact=True).click(); page.wait_for_timeout(400)
        page.click("#account-btn"); page.click(".account-menu [data-menu='out']"); page.wait_for_timeout(600)
        check("sign out in a session: Connect GitHub, deck still open", "Connect GitHub" in page.inner_text("#account-btn") and st("deckName") == "demo")

        # 10. Guest: clicking the empty slide opens the file picker; it also offers the demo.
        page.goto(BASE); page.wait_for_timeout(600)
        page.click("#welcome-create-btn"); page.wait_for_url("**/s/**"); page.wait_for_timeout(2600)
        with page.expect_file_chooser(timeout=3000) as fc:
            page.click("#stage-empty .stage-empty-title")
        check("guest: clicking the empty slide opens the file picker", fc.value is not None)
        check("guest has no library modal", page.locator(".gh-lib").count() == 0)
        shot("15-guest-empty")
        check("empty stage offers the demo", page.locator("#stage-empty-demo").is_visible())
        with page.expect_file_chooser(timeout=3000) as fc:
            page.click("#account-btn"); page.click(".account-menu [data-menu='open']")
        check("guest menu opens the file picker", fc.value is not None)
        check("edit button sits right of mute", page.locator("#edit-mode-btn").bounding_box()["x"] > page.locator("#mute-btn").bounding_box()["x"]
              and abs(page.locator("#edit-mode-btn").bounding_box()["y"] - page.locator("#mute-btn").bounding_box()["y"]) < 4)
        check("signed out, the account button says Connect GitHub", "Connect GitHub" in page.inner_text("#account-btn"))
        check("Save is off with no deck", page.locator("#save-btn").is_disabled())
        page.click("#account-btn"); page.wait_for_timeout(300); shot("16-guest-menu")
        check("guest menu: sign in, open, demo, end",
              [b.get_attribute("data-menu") for b in page.locator(".account-menu [data-menu]").all()] == ["in", "open", "demo", "end"])
        page.click(".account-menu [data-menu='end']"); page.wait_for_url(BASE); page.wait_for_timeout(500)
        check("End session returns to the start page", page.locator("#welcome-create-btn").is_visible())
        b.close()

    bad = [e for e in errors if "favicon" not in e]
    print("\nconsole errors:", *bad, sep="\n  ") if bad else print("\nno console errors")
    failed = [n for n, ok in checks if not ok]
    print(f"{len(checks) - len(failed)}/{len(checks)} checks passed")
    return not failed


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
