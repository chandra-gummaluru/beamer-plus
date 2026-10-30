"""Walk through the start page (New Session / Try Demo), the session buttons,
Open / Save presentation with the computer's own file windows, the record button, and Close session.

  python app.py --http --port 5001        (in another terminal)
  python tests/browser/flow_sessions.py   screenshots land in tests/browser/shots/

Needs Playwright (pip install playwright; playwright install chromium). The
file windows are faked over the browser's private file system (common.FAKE_FOLDER).
"""
import base64
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from playwright.sync_api import sync_playwright  # noqa: E402
from common import BASE, OUT, make_pdf, make_zip, FAKE_FOLDER, FOLDER_RESET, FOLDER_PUT  # noqa: E402

L = "csc258/lectures"
DECK = "05 - Binary Arithmetic"
FAKE_SCREEN = """
(() => {
  const c = document.createElement('canvas'); c.width = 320; c.height = 240;
  const g = c.getContext('2d');
  setInterval(() => { g.fillStyle = `hsl(${Math.random() * 360},50%,50%)`; g.fillRect(0, 0, 320, 240); }, 50);
  navigator.mediaDevices.getDisplayMedia = async () => c.captureStream(20);
  localStorage.setItem('beamer-recorder-prefs', JSON.stringify({ mic: false, sound: false }));
})();
"""


def run():
    errors, checks = [], []

    def check(name, ok):
        checks.append((name, bool(ok)))
        print(("PASS " if ok else "FAIL ") + name)

    b64 = lambda data: base64.b64encode(data).decode()
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1360, "height": 860}, accept_downloads=True)
        ctx.add_init_script(FAKE_FOLDER)
        ctx.add_init_script(FAKE_SCREEN)
        page = ctx.new_page()
        page.on("console", lambda m: (errors.append(f"{m.type}: {m.text}") if m.type == "error" else None, os.environ.get("VERBOSE") and print("  console", m.type, m.text[:200])))
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("crash", lambda: print("PAGE CRASHED"))
        shot = lambda n: page.screenshot(path=f"{OUT}/{n}.png")
        BTN = {"edit": "#session-edit-btn", "end": "#session-close-btn", "record": "#record-btn"}
        # No Open or Save button: a session starts with the Open window, and
        # saving is part of Close session. The steps that open or save
        # mid-session open the same windows directly.
        LIB = "() => import('/static/js/library/ui.js').then(m => m.{}())"
        menu = lambda key: (page.evaluate(LIB.format("savePresentation")) if key == "save"
                            else page.evaluate(LIB.format("openPresentation")) if key == "open"
                            else page.click(BTN[key]))
        shown = lambda: page.eval_on_selector_all("#top-right-controls button", "els => els.filter(e => e.getClientRects().length).map(e => e.id)")

        # 1. The start page: New Session and Try Demo.
        page.goto(BASE); page.wait_for_timeout(600)
        page.evaluate(FOLDER_RESET)
        page.evaluate(FOLDER_PUT, {f"{L}/{DECK}.zip": b64(make_zip(make_pdf())),
                                   f"{L}/06 - Multiplication.pdf": b64(make_pdf(4, "Multiplication")),
                                   "csc258/grades.json": b64(b"{}")})
        shot("s01-start")
        check("start page: New Session and Try Demo", page.inner_text("#welcome-new-btn").strip() == "New Session"
              and page.inner_text("#welcome-demo-btn").strip() == "Try Demo")
        check("…no Last Session, no GitHub", page.locator("#welcome-last-btn").count() == 0 and "GitHub" not in page.content())

        # 2. New Session: the computer's Open window straight away (presentations
        #    only); cancel it and nothing happens.
        page.evaluate("() => { window.__cancel = true; }")
        page.click("#welcome-new-btn"); page.wait_for_timeout(1200)
        types = page.evaluate("() => window.__openTypes")
        check("New Session: the file window, .pdf and .zip only", types and sorted(sum(types[0]["accept"].values(), [])) == [".pdf", ".zip"])
        check("…cancelled: still on the start page", "/s/" not in page.url and page.locator("#welcome-new-btn").is_enabled())
        page.evaluate("p => { window.__open = p; }", f"Courses/{L}/{DECK}.zip")
        page.click("#welcome-new-btn"); page.wait_for_url("**/s/**")
        page.wait_for_function("() => window.beamerState?.totalSlides === 6", timeout=15000); page.wait_for_timeout(2500)
        shot("s05-opened")
        check("…a file chosen: the session opens with it (6 slides)", page.evaluate("() => window.beamerState.totalSlides") == 6)
        check("…no window in the way", page.locator(".custom-modal-overlay").count() == 0)
        print("   buttons:", shown())
        check("…top-right: Edit and Close session", shown() == ["session-edit-btn", "session-close-btn"])
        check("record button in the corner", page.locator("#record-btn").is_visible())
        check("tab title", page.title() == f"{DECK} · Beamer+")

        # 3. A session with nothing open (reloaded): the empty stage's Open a File….
        page.reload(); page.wait_for_timeout(2800)
        shot("s02-empty")
        check("reloaded, nothing open: no window, the stage offers Open a File…",
              page.locator(".custom-modal-overlay").count() == 0 and not page.evaluate("() => !!window.beamerState.zipFile")
              and page.inner_text("#stage-empty .stage-empty-title").strip() == "Nothing here yet…"
              and page.inner_text("#stage-open-btn").strip() == "Open a File…")
        check("…top-right: Close session only", shown() == ["session-close-btn"])
        page.evaluate("p => { window.__open = p; }", f"Courses/{L}/{DECK}.zip")
        page.click("#stage-open-btn"); page.wait_for_timeout(2500)
        check("…which opens the file window, then the deck", page.evaluate("() => window.beamerState.totalSlides") == 6
              and page.locator("#stage-empty").is_hidden())

        # 4. Go to slide 3 (Save keeps the slide you're on).
        page.keyboard.press("ArrowRight"); page.keyboard.press("ArrowRight"); page.wait_for_timeout(800)

        # 5. Save: the title and what to save, then straight to the downloads folder.
        got = {}
        page.on("download", lambda d: got.__setitem__(d.suggested_filename, d.path()))
        menu("save"); page.wait_for_timeout(800); shot("s06-save")
        check("save: a window with the title and what to save", page.locator(".lib[data-mode=save]").count() == 1
              and page.input_value("[data-name]") == DECK and page.locator(".lib-chip").count() == 3)
        check("…Cancel and Save, nothing else", [x.strip() for x in page.locator(".lib-foot .btn, .lib-foot .link").all_inner_texts()] == ["Cancel", "Save"])
        page.locator(".lib-chip", has_text="Notes").click()            # just the deck
        page.fill("[data-name]", "05 - saved")
        page.click("[data-save]"); page.wait_for_timeout(2500)
        print("   downloaded:", sorted(got))
        check("saved: downloaded, no folder window", sorted(got) == ["05 - saved.zip"] and page.evaluate("() => window.__startIn") is None)
        check("…toast says where", "Saved 05 - saved.zip to your Downloads folder." in page.inner_text("#recorder-toast"))
        saved_zip = open(got["05 - saved.zip"], "rb").read()

        # 6. No Ctrl+S shortcut: the browser's own (nothing saved, no window).
        n = len(got)
        page.keyboard.press("Control+s"); page.wait_for_timeout(1200)
        check("Ctrl+S does nothing in Beamer+", page.locator(".lib").count() == 0 and len(got) == n)

        # 7. Record with the record button.
        if not os.environ.get("SKIPREC"):
            menu("record"); page.wait_for_timeout(400)
            page.locator(".custom-modal-buttons .btn", has_text="Start Recording").click(); page.wait_for_timeout(2500)
            rec = page.locator("#record-btn")
            check("recording: the Record button is the timer", ":" in rec.inner_text() and "is-live" in rec.get_attribute("class"))
            shot("s07-recording")
            rec.click(); page.wait_for_timeout(400)
            check("…a click pauses", "is-paused" in rec.get_attribute("class"))
            rec.click(); page.wait_for_timeout(400)
            check("…and resumes", "is-live" in rec.get_attribute("class"))
            rb = rec.bounding_box()
            page.mouse.move(rb["x"] + rb["width"] / 2, rb["y"] + rb["height"] / 2)
            page.mouse.down(); page.wait_for_timeout(1000); page.mouse.up(); page.wait_for_timeout(2000)
            check("…holding it stops", rec.inner_text().strip() == "Record")

        # 8. Close session: asks whether to save first (a deck is open).
        menu("end"); page.wait_for_timeout(300); shot("s08-close")
        btns = [x.inner_text().strip() for x in page.locator(".custom-modal-buttons .btn").all()]
        check(f"close session asks to save first ({btns})", "haven’t saved" in page.inner_text(".custom-modal-overlay")
              and btns == ["Cancel", "Don’t Save", "Save…"])
        page.locator(".custom-modal-buttons .btn", has_text="Cancel").click(); page.wait_for_timeout(300)
        check("…Cancel stays", "/s/" in page.url)
        menu("end"); page.wait_for_timeout(300)
        page.locator(".custom-modal-buttons .btn", has_text="Save…").click(); page.wait_for_timeout(800)
        check("…Save… opens the Save window", page.locator(".lib [data-save]").count() == 1)
        page.fill("[data-name]", "05 - closing"); page.click("[data-save]")
        page.wait_for_url(BASE, timeout=15000); page.wait_for_timeout(800)
        check("…saves, then back on the start page", page.locator("#welcome-new-btn").is_visible() and "05 - closing.zip" in got)

        # 9. New Session starts empty; the saved deck reopens at the slide it was saved on.
        page.evaluate(FOLDER_PUT, {"saved/05 - saved.zip": b64(saved_zip)})
        page.evaluate("() => { window.__open = 'Courses/saved/05 - saved.zip'; }")
        page.click("#welcome-new-btn"); page.wait_for_url("**/s/**")
        page.wait_for_function("() => window.beamerState?.totalSlides === 6", timeout=15000); page.wait_for_timeout(1500)
        check("saved deck reopens on slide 3", page.evaluate("() => window.beamerState.currentSlide") == 2)
        check("…titled as saved", page.title() == "05 - saved · Beamer+")

        # 10. Try Demo: a session with the demo deck and the tour.
        page.goto(BASE); page.wait_for_timeout(600)
        page.click("#welcome-demo-btn"); page.wait_for_url("**/s/**")
        page.wait_for_function("() => window.beamerState?.totalSlides > 3", timeout=60000); page.wait_for_timeout(2500); shot("s12-demo")
        check("Try Demo: demo deck loaded, tour running", page.evaluate("() => window.beamerState.totalSlides") > 3
              and page.locator(".tour-card, .tour-popover, [class*='tour']").count() > 0)

        # 11. A browser without File System Access: New Session is the plain file picker.
        ctx2 = b.new_context(viewport={"width": 1200, "height": 800})
        ctx2.add_init_script("delete window.showDirectoryPicker; delete window.showOpenFilePicker;")
        p2 = ctx2.new_page()
        p2.goto(BASE); p2.wait_for_timeout(500)
        with p2.expect_file_chooser(timeout=3000) as fc:
            p2.click("#welcome-new-btn")
        fc.value.set_files(files=[{"name": "06 - Multiplication.pdf", "mimeType": "application/pdf", "buffer": make_pdf(4, "Multiplication")}])
        p2.wait_for_url("**/s/**"); p2.wait_for_function("() => window.beamerState?.totalSlides === 4", timeout=15000)
        check("no File System Access: New Session's plain file picker, then the session opens it", True)
        ctx2.close()

        b.close()
    errors = [e for e in errors if "ERR_TUNNEL" not in e]
    print("\nconsole errors:\n  " + "\n  ".join(errors) if errors else "\nno console errors")
    print(f"{sum(ok for _, ok in checks)}/{len(checks)} checks passed")
    return all(ok for _, ok in checks) and not errors


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
