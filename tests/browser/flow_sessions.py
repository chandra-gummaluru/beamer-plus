"""Walk through the start page (New Session / Try Demo), the session buttons,
Open / Save presentation in folders on this computer (remembered across
sessions), the record button, and Close session.

  python app.py --http --port 5001        (in another terminal)
  python tests/browser/flow_sessions.py   screenshots land in tests/browser/shots/

Needs Playwright (pip install playwright; playwright install chromium). The
folder is the browser's private file system (common.FAKE_FOLDER).
"""
import base64
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from playwright.sync_api import sync_playwright  # noqa: E402
from common import BASE, OUT, make_pdf, make_zip, FAKE_FOLDER, FOLDER_RESET, FOLDER_PUT, FOLDER_LS  # noqa: E402

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
        go = lambda name: (page.locator(".lib-files .lib-item", has_text=name).first.click(), page.wait_for_timeout(400))
        BTN = {"edit": "#session-edit-btn", "end": "#session-close-btn", "record": "#record-btn"}
        # No Open or Save button: a session starts with the Open window, and
        # saving is part of Close session. The steps that open or save
        # mid-session open the same windows directly.
        LIB = "() => import('/static/js/library/ui.js').then(m => m.{}())"
        menu = lambda key: (page.evaluate(LIB.format("savePresentation")) if key == "save"
                            else page.evaluate(LIB.format("openPresentation")) if key == "open"
                            else page.click(BTN[key]))
        shown = lambda: page.eval_on_selector_all("#top-right-controls button", "els => els.filter(e => e.getClientRects().length).map(e => e.id)")
        sid = lambda: re.search(r"/s/([^/]+)/", page.url).group(1)

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

        # 2. New Session: the Open window comes up by itself and stays.
        page.click("#welcome-new-btn"); page.wait_for_url("**/s/**")
        page.wait_for_selector(".lib", timeout=8000); page.wait_for_timeout(300)
        first = sid()
        shot("s02-open-required")
        check("new session: the Open window comes up by itself", page.locator(".lib[data-mode=open]").count() == 1)
        page.keyboard.press("Escape"); page.mouse.click(5, 5); page.wait_for_timeout(900)
        check("…and stays (no ×, Escape and clicking outside don't close it)",
              page.locator(".lib[data-mode=open]").count() == 1 and not page.locator(".custom-modal-x-btn").is_visible())
        print("   buttons:", shown())
        check("top-right, nothing open: Close session only", shown() == ["session-close-btn"])
        check("record button in the corner", page.locator("#record-btn").is_visible())
        check("empty slide: 'Nothing here yet…' and how to start", page.inner_text("#stage-empty .stage-empty-title").strip() == "Nothing here yet…"
              and "opening a presentation" in page.inner_text("#stage-empty .stage-empty-hint")
              and page.locator("#stage-empty button").count() == 0)

        # 3. Open: choose the folder, browse, open a deck.
        menu("open"); page.wait_for_timeout(500); shot("s03-open-choose")
        check("open, first time: asks for a folder", page.locator(".lib [data-choose]").count() == 1)
        page.click(".lib [data-choose]"); page.wait_for_timeout(700)
        check("…then shows it, with Change folder", "Courses" in page.inner_text(".lib-folder") and page.locator("[data-change]").count() == 1)
        check("…lists folders and decks only", page.locator(".lib-files .lib-item").all_inner_texts() == ["csc258"])
        go("csc258"); go("lectures"); shot("s04-open-browse")
        items = [t.split("\n")[0] for t in page.locator(".lib-files .lib-item").all_inner_texts()]
        check(f"…the lecture folder ({items})", items == ["..", f"{DECK}.zip", "06 - Multiplication.pdf"])
        go(f"{DECK}.zip"); page.wait_for_timeout(2500); shot("s05-opened")
        check("deck opened (6 slides)", page.evaluate("() => window.beamerState.totalSlides") == 6)
        check("…top-right now: Edit and Close session", shown() == ["session-edit-btn", "session-close-btn"])
        check("tab title", page.title() == f"{DECK} · Beamer+")

        # 4. Go to slide 3 (Save keeps the slide you're on).
        page.keyboard.press("ArrowRight"); page.keyboard.press("ArrowRight"); page.wait_for_timeout(800)

        # 5. Save has its own folder: the first time, choose one (or use Open's).
        menu("save"); page.wait_for_timeout(800); shot("s06-save-choose")
        check("save, first time: choose a folder, or use the Open one",
              page.locator(".lib [data-choose]").count() == 1 and page.inner_text(".lib [data-adopt]").strip() == "Use Courses")
        page.evaluate("() => { window.__pick = 'Saves'; }")
        page.click(".lib [data-choose]"); page.wait_for_timeout(700); shot("s06-save")
        check("…a different folder for saving", "Save to" in page.inner_text(".lib-folder") and "Saves" in page.inner_text(".lib-folder"))
        crumbs = page.inner_text(".lib-crumbs").replace("\n", " ")
        check(f"…starts at its top (the deck isn't in it) ({crumbs})", crumbs.strip() == "Saves")
        check("…with the deck's name", page.input_value("[data-name]") == DECK)
        check("…and a way to download instead", page.locator("[data-local]").inner_text().strip() == "Or download instead")
        page.locator(".lib-chip", has_text="Notes").click()            # just the deck
        page.fill("[data-name]", "05 - saved"); page.click("[data-save]"); page.wait_for_timeout(2500)
        files = page.evaluate(FOLDER_LS, "Saves")
        check("saved into the save folder", "05 - saved.zip" in files)
        check("…not the open folder", not any(k.endswith("05 - saved.zip") for k in page.evaluate(FOLDER_LS)))
        check("…toast says where", "Saved Saves/05 - saved.zip" in page.inner_text("#recorder-toast"))
        # A subfolder of the save folder, saved again: Save starts there next time.
        menu("save"); page.wait_for_timeout(800)
        page.evaluate("async () => { const r = await (await navigator.storage.getDirectory()).getDirectoryHandle('Saves'); await r.getDirectoryHandle('csc258', { create: true }); }")
        menu_refresh = page.locator(".lib-crumb").first; menu_refresh.click(); page.wait_for_timeout(500)
        go("csc258"); page.click("[data-save]"); page.wait_for_timeout(2500)
        files = page.evaluate(FOLDER_LS, "Saves")
        check("saved into a subfolder", "csc258/05 - saved.zip" in files)

        # 6. No Ctrl+S shortcut: the browser's own (nothing saved, no window).
        page.keyboard.press("Control+s"); page.wait_for_timeout(1200)
        check("Ctrl+S does nothing in Beamer+", page.locator(".lib").count() == 0 and page.evaluate(FOLDER_LS, "Saves") == files)

        # 7. Record with the record button.
        if not os.environ.get("SKIPREC"):
            menu("record"); page.wait_for_timeout(400)
            page.locator(".custom-modal-btn", has_text="Start recording").click(); page.wait_for_timeout(2500)
            check("recording: the bar shows", page.locator("#recorder-bar").is_visible())
            shot("s07-recording")
            check("…in the record button's place", page.locator("#record-btn").is_hidden())
            page.click("#recorder-stop-btn"); page.wait_for_timeout(2000)
            check("…stopped", page.locator("#recorder-bar").is_hidden())

        # 8. Close session: asks whether to save first (a deck is open).
        menu("end"); page.wait_for_timeout(300); shot("s08-close")
        btns = [x.inner_text().strip() for x in page.locator(".custom-modal-btn").all()]
        check(f"close session asks to save first ({btns})", "haven’t saved" in page.inner_text(".custom-modal-overlay")
              and btns == ["Cancel", "Don’t Save", "Save…"])
        page.locator(".custom-modal-btn", has_text="Cancel").click(); page.wait_for_timeout(300)
        check("…Cancel stays", "/s/" in page.url)
        menu("end"); page.wait_for_timeout(300)
        page.locator(".custom-modal-btn", has_text="Save…").click(); page.wait_for_timeout(800)
        check("…Save… opens the Save window", page.locator(".lib [data-save]").count() == 1)
        page.fill("[data-name]", "05 - closing"); page.click("[data-save]")
        page.wait_for_url(BASE, timeout=15000); page.wait_for_timeout(800)
        check("…saves, then back on the start page", page.locator("#welcome-new-btn").is_visible()
              and any(k.endswith("05 - closing.zip") for k in page.evaluate(FOLDER_LS, "Saves")))

        # 9. New Session starts empty; both folders are remembered, each where
        #    you last were in it; the saved deck reopens at the slide it was saved on.
        page.click("#welcome-new-btn"); page.wait_for_url("**/s/**"); page.wait_for_selector(".lib", timeout=8000); page.wait_for_timeout(500)
        check("New Session: nothing open", not page.evaluate("() => !!window.beamerState.zipFile"))
        menu("open"); page.wait_for_timeout(800)
        check("next session, Open: Courses, where I last opened from",
              "Courses" in page.inner_text(".lib-folder") and page.inner_text(".lib-crumbs").replace("\n", " ").strip() == "Courses › csc258 › lectures")
        go("06 - Multiplication.pdf"); page.wait_for_timeout(2500)
        menu("save"); page.wait_for_timeout(800); shot("s11-save-remembered")
        check("…Save: Saves, where I last saved",
              "Saves" in page.inner_text(".lib-folder") and page.inner_text(".lib-crumbs").replace("\n", " ").strip() == "Saves › csc258")
        page.evaluate("() => window.BeamerModal.close()"); page.wait_for_timeout(300)
        page.evaluate("() => { window.__pick = 'Saves'; }")
        menu("open"); page.wait_for_timeout(500)
        page.click(".lib [data-change]"); page.wait_for_timeout(700)
        go("csc258"); go("05 - saved.zip"); page.wait_for_timeout(2500)
        check("saved deck reopens on slide 3", page.evaluate("() => window.beamerState.currentSlide") == 2)

        # 10. Try Demo: a session with the demo deck and the tour.
        page.goto(BASE); page.wait_for_timeout(600)
        page.click("#welcome-demo-btn"); page.wait_for_url("**/s/**")
        page.wait_for_function("() => window.beamerState?.totalSlides > 3", timeout=60000); page.wait_for_timeout(2500); shot("s12-demo")
        check("Try Demo: demo deck loaded, tour running", page.evaluate("() => window.beamerState.totalSlides") > 3
              and page.locator(".tour-card, .tour-popover, [class*='tour']").count() > 0)

        # 11. A browser without folders: the Open window offers the file picker.
        ctx2 = b.new_context(viewport={"width": 1200, "height": 800})
        ctx2.add_init_script("delete window.showDirectoryPicker;")
        p2 = ctx2.new_page()
        p2.goto(BASE); p2.wait_for_timeout(500); p2.click("#welcome-new-btn"); p2.wait_for_url("**/s/**")
        p2.wait_for_selector(".lib [data-pick]", timeout=8000)
        with p2.expect_file_chooser(timeout=3000) as fc:
            p2.click(".lib [data-pick]")
        check("no folder support: the Open window's Choose a File… is the file picker", fc.value is not None)
        ctx2.close()

        b.close()
    errors = [e for e in errors if "ERR_TUNNEL" not in e]
    print("\nconsole errors:\n  " + "\n  ".join(errors) if errors else "\nno console errors")
    print(f"{sum(ok for _, ok in checks)}/{len(checks)} checks passed")
    return all(ok for _, ok in checks) and not errors


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
