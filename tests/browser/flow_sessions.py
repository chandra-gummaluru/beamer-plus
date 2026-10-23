"""Walk through the start page (New Session / Last Session), the session buttons,
Open / Save presentation in a folder on this computer, recording from
the record button, and Last Session bringing a presentation back as it was left.

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
LAST = """async () => {
  const db = await new Promise(r => { const q = indexedDB.open('beamer-last-session', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => r(q.result); });
  const get = k => new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => r(q.result || null); });
  const meta = await get('meta'), deck = await get('deck');
  return { meta, deckSize: deck?.blob?.size || 0, deckAt: deck?.savedAt || null };
}"""
SET_LAST_SESSION = """async (id) => {
  const db = await new Promise(r => { const q = indexedDB.open('beamer-last-session', 1); q.onsuccess = () => r(q.result); });
  const tx = db.transaction('kv', 'readwrite'), st = tx.objectStore('kv');
  const meta = await new Promise(r => { const q = st.get('meta'); q.onsuccess = () => r(q.result); });
  st.put({ ...meta, sessionId: id }, 'meta');
  await new Promise(r => tx.oncomplete = r);
}"""
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
        BTN = {"open": "#session-open-btn", "edit": "#session-edit-btn", "save": "#session-save-btn",
               "end": "#session-close-btn", "record": "#record-btn"}
        menu = lambda key: page.click(BTN[key])
        sid = lambda: re.search(r"/s/([^/]+)/", page.url).group(1)

        # 1. The start page, first time: New Session, and Last Session greyed out.
        page.goto(BASE); page.wait_for_timeout(600)
        page.evaluate(FOLDER_RESET)
        page.evaluate(FOLDER_PUT, {f"{L}/{DECK}.zip": b64(make_zip(make_pdf())),
                                   f"{L}/06 - Multiplication.pdf": b64(make_pdf(4, "Multiplication")),
                                   "csc258/grades.json": b64(b"{}")})
        shot("s01-start")
        check("start page: New Session and Last Session", page.inner_text("#welcome-new-btn").strip() == "New Session"
              and page.inner_text("#welcome-last-btn").strip() == "Last Session")
        check("…Last Session greyed out with nothing to reopen", page.locator("#welcome-last-btn").is_disabled()
              and page.locator("#welcome-last").is_hidden())
        check("…no GitHub anywhere", "GitHub" not in page.content())

        # 2. New Session: Open, Edit, Save, Close; nothing open yet.
        page.click("#welcome-new-btn"); page.wait_for_url("**/s/**"); page.wait_for_timeout(2200)
        first = sid()
        shot("s02-buttons-empty")
        btns = page.eval_on_selector_all("#top-right-controls button", "els => els.map(e => [e.id, e.disabled])")
        print("   buttons:", btns)
        check("top-right: open, edit, save, close", [k for k, _ in btns] == ["session-open-btn", "session-edit-btn", "session-save-btn", "session-close-btn"])
        check("…edit and save need a presentation", dict(btns)["session-edit-btn"] and dict(btns)["session-save-btn"] and not dict(btns)["session-open-btn"])
        check("record button in the corner", page.locator("#record-btn").is_visible())

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
        check("…edit and save now on", not page.locator("#session-edit-btn").is_disabled() and not page.locator("#session-save-btn").is_disabled())
        check("tab title", page.title() == f"{DECK} · Beamer+")

        # 4. Draw on slide 2 and stay on slide 3: the browser keeps a copy.
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(700)
        box = page.locator("#ann-canvas canvas").first.bounding_box()
        page.mouse.move(box["x"] + 100, box["y"] + 100); page.mouse.down()
        for i in range(12):
            page.mouse.move(box["x"] + 100 + i * 20, box["y"] + 100 + (i % 3) * 15)
        page.mouse.up(); page.wait_for_timeout(300)
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(5500)
        last = page.evaluate(LAST)
        print("   kept:", last["meta"], last["deckSize"])
        check("a copy is kept: on slide 3, with the deck", last["meta"]["slide"] == 2 and last["deckSize"] > 1000
              and last["meta"]["sessionId"] == first and last["meta"]["name"] == DECK)
        page.keyboard.press("ArrowLeft"); page.wait_for_timeout(1500)
        check("moving slides updates only the slide", page.evaluate(LAST)["meta"]["slide"] == 1 and page.evaluate(LAST)["deckAt"] == last["deckAt"])
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(1500)

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

        # 8. Close session; Last Session brings it back, same code, same slide, same ink.
        menu("end"); page.wait_for_timeout(300); shot("s08-end")
        check("close session says Last Session picks up", "Last Session" in page.inner_text(".custom-modal-overlay"))
        page.locator(".custom-modal-btn", has_text="Close session").click()
        page.wait_for_url(BASE); page.wait_for_timeout(800); shot("s09-start-again")
        line = page.inner_text("#welcome-last")
        print("   ", line)
        check("start page: Last Session ready, says what and where", not page.locator("#welcome-last-btn").is_disabled()
              and "05 - saved" in line and "slide 3 of 6" in line)
        page.click("#welcome-last-btn"); page.wait_for_url("**/s/**"); page.wait_for_timeout(4500); shot("s10-resumed")
        check("same session code (still on the server)", sid() == first)
        check("…the ?resume is gone from the address", "resume" not in page.url)
        st = page.evaluate("() => ({ n: window.beamerState.totalSlides, at: window.beamerState.currentSlide, ink: Object.keys(window.beamerState.annotations), target: window.beamerState.target })")
        print("   resumed:", st)
        check("…deck back, on slide 3", st["n"] == 6 and st["at"] == 2)
        check("…with the ink on slide 2", "1" in st["ink"])
        check("…and its place in the folder (Save goes back there)", st["target"]["name"] == "05 - saved" and st["target"]["src"] == "save" and st["target"]["dir"] == "csc258")

        # 9. The server lost that session: Last Session opens it in a new one.
        page.evaluate(SET_LAST_SESSION, "ZZZZZZ")
        page.goto(BASE); page.wait_for_timeout(600)
        page.click("#welcome-last-btn"); page.wait_for_url("**/s/**"); page.wait_for_timeout(4500)
        check("gone from the server: a new session, deck back", sid() not in (first, "ZZZZZZ")
              and page.evaluate("() => window.beamerState.totalSlides") == 6)

        # 10. New Session starts empty (the kept copy stays for Last Session);
        #     both folders are remembered, each where you last were in it.
        page.goto(BASE); page.wait_for_timeout(600)
        page.click("#welcome-new-btn"); page.wait_for_url("**/s/**"); page.wait_for_timeout(2500)
        check("New Session: nothing open", not page.evaluate("() => !!window.beamerState.zipFile"))
        menu("open"); page.wait_for_timeout(800)
        check("next session, Open: Courses, where I last opened from",
              "Courses" in page.inner_text(".lib-folder") and page.inner_text(".lib-crumbs").replace("\n", " ").strip() == "Courses › csc258 › lectures")
        go("06 - Multiplication.pdf"); page.wait_for_timeout(2500)
        menu("save"); page.wait_for_timeout(800); shot("s11-save-remembered")
        check("…Save: Saves, where I last saved",
              "Saves" in page.inner_text(".lib-folder") and page.inner_text(".lib-crumbs").replace("\n", " ").strip() == "Saves › csc258")
        page.keyboard.press("Escape")
        page.goto(BASE); page.wait_for_timeout(600)
        check("…Last Session still there", not page.locator("#welcome-last-btn").is_disabled())

        # 11. A browser without folders: Open is the file picker.
        ctx2 = b.new_context(viewport={"width": 1200, "height": 800})
        ctx2.add_init_script("delete window.showDirectoryPicker;")
        p2 = ctx2.new_page()
        p2.goto(BASE); p2.wait_for_timeout(500); p2.click("#welcome-new-btn"); p2.wait_for_url("**/s/**"); p2.wait_for_timeout(2200)
        with p2.expect_file_chooser(timeout=3000) as fc:
            p2.click("#session-open-btn")
        check("no folder support: Open is the file picker", fc.value is not None)
        ctx2.close()

        b.close()
    # (the 404 is step 9 asking the server for the session it no longer has)
    errors = [e for e in errors if "ERR_TUNNEL" not in e and "404 (NOT FOUND)" not in e]
    print("\nconsole errors:\n  " + "\n  ".join(errors) if errors else "\nno console errors")
    print(f"{sum(ok for _, ok in checks)}/{len(checks)} checks passed")
    return all(ok for _, ok in checks) and not errors


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
