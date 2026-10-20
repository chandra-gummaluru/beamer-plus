"""Walk through Beamer+'s session menu, Open / Save presentation on GitHub (a fake one,
fakegh.py) and in a folder (the browser's private file system standing in).

  python app.py --http --port 5001        (in another terminal)
  python tests/browser/flow_github.py     screenshots land in tests/browser/shots/

Needs Playwright (pip install playwright; playwright install chromium).
"""
import io
import re
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
    size: 11, status:'done', lecture:'csc258/f26/lectures/05 - Binary Arithmetic/05 - Binary Arithmetic' });
  tx.objectStore('chunks').add({ recId:'rec-1', seq:0, blob: new Blob(['hello video'], {type:'video/webm'}) });
  await new Promise(r => tx.oncomplete = r);
}"""


# Signed out, "Choose a folder" gets a folder in the browser's private file system
# (Playwright can't drive the real folder picker), laid out like the repositories.
FAKE_FOLDER = r"""() => {
  window.showDirectoryPicker = async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('teaching', { create: true });
    return root;
  };
}"""
SEED_FOLDER = r"""async (zipB64) => {
  const bytes = Uint8Array.from(atob(zipB64), c => c.charCodeAt(0));
  const top = await navigator.storage.getDirectory();
  try { await top.removeEntry('teaching', { recursive: true }); } catch (e) {}
  const root = await top.getDirectoryHandle('teaching', { create: true });
  const d = await root.getDirectoryHandle('csc258', { create: true });
  const fh = await d.getFileHandle('07 - Adders.zip', { create: true });
  const w = await fh.createWritable(); await w.write(bytes); await w.close();
}"""
LIST_FOLDER = r"""async () => {
  const out = [];
  const walk = async (d, pre) => { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') await walk(h, pre + n + '/'); else out.push(pre + n); } };
  await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('teaching'), '');
  return out.sort();
}"""


def menu_keys(page):
    return [b.get_attribute("data-menu") for b in page.locator(".account-menu [data-menu]").all()]


def run():
    import base64
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
        ctx.add_init_script(f"({FAKE_FOLDER})()")
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        shot = lambda n: page.screenshot(path=f"{OUT}/{n}.png")
        st = lambda expr: page.evaluate(f"() => {{ const s = window.beamerState || {{}}; return s.{expr}; }}")
        menu = lambda key: (page.click("#account-btn"), page.click(f".account-menu [data-menu='{key}']"))
        items = lambda: [x.inner_text().strip() for x in page.locator(".gh-files .gh-item").all()]
        crumbs = lambda: [x.inner_text().strip() for x in page.locator(".gh-crumbs .gh-crumb").all()]
        go = lambda name: (page.locator(".gh-files .gh-item", has_text=name).first.click(), page.wait_for_timeout(400))

        # 1. Start page.
        page.goto(BASE); page.wait_for_timeout(700); shot("01-welcome")
        check("start page: Sign in with GitHub / Continue as guest",
              "Sign in with GitHub" in page.inner_text("#welcome-github-btn") and page.locator("#welcome-create-btn").is_visible())
        # 2. Signed in, the start page goes straight to a new session; Open: choose a repository, then browse.
        page.evaluate(SIGN_IN); page.reload(); page.wait_for_url("**/s/**", timeout=5000); page.wait_for_timeout(3200); shot("02-open-repo")
        check("signed in: the start page goes straight to a new session", "/s/" in page.url)
        check("open window asks for a repository first", page.locator(".gh-lib select[data-repo]").count() == 1 and page.locator(".gh-files").count() == 0)
        page.select_option(".gh-lib select[data-repo]", "chandra-gummaluru/courses-private"); page.wait_for_timeout(1200); shot("03-browse-root")
        check("then its top folder", crumbs() == ["courses-private"] and items() == ["csc108", "csc258"])
        check("repository list ends with Add another repository; refresh is a button beside it",
              page.locator(".gh-lib select[data-repo] option").last.inner_text() == "Add another repository…"
              and page.locator(".gh-repo-row [data-again]").count() == 1 and "Not listed" not in page.inner_text(".gh-lib-src"))
        go("csc258"); go("f26")
        check("folders open in place, with a path", crumbs() == ["courses-private", "csc258", "f26"] and items() == ["..", "lectures", "grades.json"][:2])
        go("lectures"); go("05 - Binary Arithmetic"); shot("04-browse-deep")
        check("only presentations are listed", [i.split("\n")[0] for i in items()] == ["..", "05 - Binary Arithmetic.zip"])
        page.locator(".gh-crumb", has_text="f26").click(); page.wait_for_timeout(300)
        check("a path step goes back up", crumbs()[-1] == "f26")
        go("lectures"); go("05 - Binary Arithmetic"); go("05 - Binary Arithmetic.zip"); page.wait_for_timeout(2500)
        check("opened, remembering where it came from", st("ghTarget && s.ghTarget.dir") == L and st("ghTarget.name") == "05 - Binary Arithmetic")
        for _ in range(3):
            page.keyboard.press("ArrowRight"); page.wait_for_timeout(350)

        # 3. The session menu; Save presentation starts in the same repository and folder.
        page.evaluate(FAKE_TAKE)
        page.click("#account-btn"); page.wait_for_timeout(300); shot("05-session-menu")
        check("session menu: open, edit, save, end",
              [x.get_attribute("data-menu") for x in page.locator(".account-menu [data-menu]").all()] == ["open", "edit", "save", "end"])
        check("menu top says who is signed in", page.inner_text(".account-menu-head").strip() == "Signed in to GitHub as chandra-gummaluru.")
        page.click(".account-menu [data-menu='save']"); page.wait_for_timeout(1500); shot("06-save-window")
        check("save window: same repository and folder", page.input_value(".gh-lib select[data-repo]") == "chandra-gummaluru/courses-private"
              and crumbs()[-1] == "05 - Binary Arithmetic")
        check("same name", page.input_value("[data-name]") == "05 - Binary Arithmetic")
        check("three checkboxes: Presentation, Notes, Recordings (1)",
              [" ".join(x.inner_text().split()) for x in page.locator(".gh-chips .gh-chip").all()] == ["Presentation", "Notes", "Recordings 1"]
              and page.locator("[data-recs]").is_checked())
        box = page.locator(".custom-modal-content").bounding_box()
        check("the window fits the screen", box["y"] >= 0 and box["y"] + box["height"] <= 860)
        page.click("[data-save]"); page.wait_for_timeout(6000); shot("07-saved")
        pf = priv.files()
        z = pf.get(f"{L}/05 - Binary Arithmetic.zip")
        check("saved over the zip, with the slide to resume at", z is not None and json.loads(zipfile.ZipFile(io.BytesIO(z)).read("config/resume.json")).get("slide") == 3)
        check("notes PDF beside it", pf.get(f"{L}/05 - Binary Arithmetic.pdf", b"")[:5] == b"%PDF-")
        check("recording beside it", any(re.match(rf"{re.escape(L)}/05 - Binary Arithmetic-\d{{4}}-\d\d-\d\d-\d\d-\d\d\.webm$", k) for k in pf))

        # 4. No keyboard shortcut for saving.
        n = len(priv.commits)
        page.keyboard.press("Control+s"); page.wait_for_timeout(1500)
        check("Ctrl+S doesn't save", len(priv.commits) == n and page.locator(".gh-lib").count() == 0)

        # 5. Edit presentation from the menu; the editor's close button ends it.
        menu("edit"); page.wait_for_timeout(800)
        check("edit mode from the menu", st("editMode") is True and page.locator("#edit-mode-btn").is_visible())
        page.click("#edit-mode-btn"); page.wait_for_timeout(600)
        check("closed again", not st("editMode") and not page.locator("#edit-mode-btn").is_visible())

        # 6. A new session opens where you were, and the zip resumes.
        first = page.url
        page.goto(BASE); page.wait_for_url("**/s/**", timeout=5000); page.wait_for_timeout(4200); shot("08-reopen")
        check("typing the bare address while signed in starts a new session", "/s/" in page.url and page.url != first)
        check("opens in the last folder", crumbs()[-1] == "05 - Binary Arithmetic")
        go("05 - Binary Arithmetic.zip"); page.wait_for_timeout(3000)
        check("resumed at slide 4", st("currentSlide") == 3)

        # 7. Save somewhere else: another repository, a new folder.
        menu("save"); page.wait_for_timeout(1500)
        page.select_option(".gh-lib select[data-repo]", "chandra-gummaluru/courses"); page.wait_for_timeout(1200)
        go("csc258"); go("f26")
        shot("09-save-elsewhere")
        check("no New folder button in Save", page.locator("[data-newdir]").count() == 0)
        page.click("[data-save]"); page.wait_for_timeout(5000)
        uf = pub.files()
        check("saved in courses › csc258/f26", "csc258/f26/05 - Binary Arithmetic.zip" in uf and "csc258/f26/05 - Binary Arithmetic.pdf" in uf)
        check("the next save starts there", st("ghTarget.src") == "github:chandra-gummaluru/courses" and st("ghTarget.dir") == "csc258/f26")

        # 8. Open shows only the browser: no New folder or Upload buttons.
        menu("open"); page.wait_for_timeout(1500)
        check("open starts in the repository and folder in use", page.input_value(".gh-lib select[data-repo]") == "chandra-gummaluru/courses" and crumbs()[-1] == "f26")
        check("no New folder or Upload buttons", page.locator(".gh-lib [data-newdir], .gh-lib [data-upload]").count() == 0)
        page.evaluate("window.BeamerModal && window.BeamerModal.close()")

        # 8b. Signed in: open a file from this computer, save to a folder on it (system pickers).
        page.evaluate(SEED_FOLDER, base64.b64encode(make_zip(make_pdf(4, "Adders"))).decode())
        adders = os.path.join(OUT, "07 - Adders.zip")
        with open(adders, "wb") as f:
            f.write(make_zip(make_pdf(4, "Adders")))
        menu("open"); page.wait_for_timeout(1500)
        check("open list offers a file on this computer",
              "A file on this computer…" in [o.inner_text() for o in page.locator(".gh-lib select[data-repo] option").all()])
        with page.expect_file_chooser(timeout=3000) as fc:
            page.select_option(".gh-lib select[data-repo]", "__folder")
        fc.value.set_files(adders); page.wait_for_timeout(2500)
        check("it's the file picker; the file opens", st("deckName") == "07 - Adders" and not st("ghTarget") and page.locator(".gh-lib").count() == 0)
        menu("save"); page.wait_for_timeout(1500)
        check("save list offers a folder on this computer",
              "A folder on this computer…" in [o.inner_text() for o in page.locator(".gh-lib select[data-repo] option").all()])
        page.select_option(".gh-lib select[data-repo]", "__folder"); page.wait_for_timeout(1500); shot("10c-save-folder")
        check("the folder picker; then just the folder, a name and what to save", "teaching" in page.inner_text(".gh-lib-src")
              and page.locator(".gh-files").count() == 0 and page.input_value("[data-name]") == "07 - Adders")
        page.click("[data-save]"); page.wait_for_timeout(4000)
        files = page.evaluate(LIST_FOLDER)
        check("saved into that folder", "07 - Adders.zip" in files and "07 - Adders.pdf" in files)
        menu("save"); page.wait_for_timeout(1500)
        check("the next save starts there", page.input_value(".gh-lib select[data-repo]") == "__folder")
        page.select_option(".gh-lib select[data-repo]", "chandra-gummaluru/courses"); page.wait_for_timeout(1200)
        check("switching back to a repository browses it", crumbs()[0] == "courses")
        page.evaluate("window.BeamerModal && window.BeamerModal.close()")

        # 9. Signed in, a dropped file doesn't open by itself.
        page.evaluate("""() => { const dt = new DataTransfer(); dt.items.add(new File(['%PDF-1.4'], 'dropped.pdf', {type:'application/pdf'}));
            for (const t of ['dragenter','dragover','drop']) window.dispatchEvent(new DragEvent(t, {dataTransfer: dt, bubbles: true, cancelable: true})); }""")
        page.wait_for_timeout(1500)
        check("drop opens the Open window instead", page.locator(".gh-lib").count() == 1 and st("deckName") == "07 - Adders")
        check("no single-file option when signed in", page.locator("[data-single]").count() == 0)
        page.evaluate("window.BeamerModal && window.BeamerModal.close()")

        # 10. End session signs out and returns to the start page.
        menu("end"); page.wait_for_timeout(300)
        check("ending asks first, saying it signs out", "signed out of GitHub" in page.inner_text(".custom-modal-content"))
        page.click(".custom-modal-btn-ok"); page.wait_for_url(BASE); page.wait_for_timeout(800)
        check("back at the start page, signed out", "Sign in with GitHub" in page.inner_text("#welcome-github-btn")
              and page.evaluate("!sessionStorage.getItem('beamer.github') && !localStorage.getItem('beamer.github')"))

        # 11. Signed out, the same windows browse a folder on this computer.
        page.evaluate(SEED_FOLDER, base64.b64encode(make_zip(make_pdf(4, "Adders"))).decode())
        page.goto(BASE); page.wait_for_timeout(600)
        page.click("#welcome-create-btn"); page.wait_for_url("**/s/**"); page.wait_for_timeout(2600)
        page.click("#account-btn"); page.wait_for_timeout(300); shot("10-guest-menu")
        check("guest: the button says Guest", page.inner_text("#account-btn").strip() == "Guest")
        check("guest menu: open, edit (off), save (off), end; no sign-in",
              [x.get_attribute("data-menu") for x in page.locator(".account-menu [data-menu]").all()] == ["open", "edit", "save", "end"]
              and page.locator(".account-menu [data-menu='save']").is_disabled())
        page.keyboard.press("Escape")
        adders = os.path.join(OUT, "07 - Adders.zip")
        with open(adders, "wb") as f:
            f.write(make_zip(make_pdf(4, "Adders")))
        check("empty slide: one line, two links", " ".join(page.inner_text(".stage-empty-hint").split()) == "Open a presentation or try the demo.")
        page.click("#stage-empty .stage-empty-title"); page.wait_for_timeout(500)
        check("the slide itself isn't clickable", page.locator(".gh-lib").count() == 0)
        bg = page.evaluate("getComputedStyle(document.getElementById('stage-empty')).backgroundColor")
        page.hover("#stage-empty .stage-empty-icon"); page.wait_for_timeout(300)
        check("no hover colour on the slide", page.evaluate("getComputedStyle(document.getElementById('stage-empty')).backgroundColor") == bg)
        with page.expect_file_chooser(timeout=3000) as fc:
            page.click("#stage-empty-open")
        check("signed out, Open is just the file picker", page.locator(".gh-lib").count() == 0)
        fc.value.set_files(adders); page.wait_for_timeout(2500)
        check("opened from this computer", st("deckName") == "07 - Adders" and not st("ghTarget"))
        with page.expect_file_chooser(timeout=3000) as fc:
            menu("open")
        check("the menu's Open is the file picker too", fc.value is not None)
        page.keyboard.press("Escape")
        # Save picks a folder on this computer (or downloads).
        menu("save"); page.wait_for_timeout(800); shot("11-folder-none")
        check("save window: the remembered folder (Change…) or Download instead; no browsing",
              "teaching" in page.inner_text(".gh-lib-src") and "Change" in page.inner_text(".gh-lib-src")
              and page.locator("[data-download]").count() == 1 and page.locator(".gh-files").count() == 0); shot("12-folder-save")
        page.fill("[data-name]", "adders guest"); page.click("[data-save]"); page.wait_for_timeout(5000)
        files = page.evaluate(LIST_FOLDER)
        check("saved in the folder", "adders guest.zip" in files and "adders guest.pdf" in files)
        page.click("#account-btn"); page.click(".account-menu [data-menu='end']"); page.wait_for_timeout(300)
        page.click(".custom-modal-btn-ok"); page.wait_for_url(BASE); page.wait_for_timeout(500)
        check("End session returns to the start page", page.locator("#welcome-create-btn").is_visible())
        b.close()

    bad = [e for e in errors if "favicon" not in e and "ERR_TUNNEL" not in e]
    print("\nconsole errors:", *bad, sep="\n  ") if bad else print("\nno console errors")
    failed = [n for n, ok in checks if not ok]
    print(f"{len(checks) - len(failed)}/{len(checks)} checks passed")
    return not failed


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
