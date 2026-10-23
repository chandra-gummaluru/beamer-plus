"""Walk through the start page (New Session / Last Session), the session menu,
Open / Save presentation in a folder on this computer, Ctrl+S, recording from
the menu, and Last Session bringing a presentation back as it was left.

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
        open_menu = lambda: (page.click("#session-btn"), page.wait_for_timeout(150))
        menu = lambda key: (open_menu(), page.click(f".session-menu [data-menu='{key}']"))
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

        # 2. New Session: the session menu, nothing open yet.
        page.click("#welcome-new-btn"); page.wait_for_url("**/s/**"); page.wait_for_timeout(2200)
        first = sid()
        check("session button says Session", page.inner_text("#session-btn").strip() == "Session")
        check("no record button in the corner", page.locator("#record-btn").count() == 0)
        open_menu(); shot("s02-menu-empty")
        keys = page.eval_on_selector_all(".session-menu [data-menu]", "els => els.map(e => [e.dataset.menu, e.disabled])")
        print("   menu:", keys)
        check("menu: open, edit, save, record, end", [k for k, _ in keys] == ["open", "edit", "save", "record", "end"])
        check("…edit and save need a presentation", dict(keys)["edit"] and dict(keys)["save"] and not dict(keys)["open"])
        check("…the head names the session", first in page.inner_text(".session-menu-head"))
        page.keyboard.press("Escape")

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
        check("session button shows its name", page.inner_text("#session-btn").strip() == DECK)
        check("tab title", page.title() == f"{DECK} · Beamer+")
        open_menu()
        check("menu head: where it came from", f"in Courses/{L}" in page.inner_text(".session-menu-head"))
        page.keyboard.press("Escape")

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

        # 5. Save: starts in the deck's folder with its name; writes it there.
        menu("save"); page.wait_for_timeout(800); shot("s06-save")
        crumbs = page.inner_text(".lib-crumbs").replace("\n", " ")
        check(f"save starts where it came from ({crumbs})", "csc258" in crumbs and "lectures" in crumbs)
        check("…with its name", page.input_value("[data-name]") == DECK)
        check("…and a way to download instead", page.locator("[data-local]").inner_text().strip() == "Or download instead")
        page.locator(".lib-chip", has_text="Notes").click()            # just the deck
        page.fill("[data-name]", "05 - saved"); page.click("[data-save]"); page.wait_for_timeout(2500)
        files = page.evaluate(FOLDER_LS)
        check("saved into the folder", f"{L}/05 - saved.zip" in files)
        check("…toast says where", "Saved Courses/csc258/lectures/05 - saved.zip" in page.inner_text("#recorder-toast"))
        check("…button follows the new name", page.inner_text("#session-btn").strip() == "05 - saved")

        # 6. Ctrl+S saves again, there, without asking.
        size0 = files[f"{L}/05 - saved.zip"]
        page.keyboard.press("ArrowRight"); page.wait_for_timeout(400)
        page.keyboard.press("Control+s"); page.wait_for_timeout(2500)
        check("Ctrl+S: no window, saved again", page.locator(".lib").count() == 0 and "05 - saved.zip" in page.inner_text("#recorder-toast"))
        page.keyboard.press("ArrowLeft"); page.wait_for_timeout(400)

        # 7. Record from the menu.
        if not os.environ.get("SKIPREC"):
            menu("record"); page.wait_for_timeout(400)
            page.locator(".custom-modal-btn", has_text="Start recording").click(); page.wait_for_timeout(2500)
            check("recording: the bar shows", page.locator("#recorder-bar").is_visible())
            open_menu(); shot("s07-recording-menu")
            check("…menu offers Stop recording", page.inner_text(".session-menu [data-menu='record']").strip() == "Stop recording")
            page.click(".session-menu [data-menu='record']"); page.wait_for_timeout(2000)
            check("…stopped", page.locator("#recorder-bar").is_hidden())

        # 8. End session; Last Session brings it back, same code, same slide, same ink.
        menu("end"); page.wait_for_timeout(300); shot("s08-end")
        check("end session says Last Session picks up", "Last Session" in page.inner_text(".custom-modal-overlay"))
        page.locator(".custom-modal-btn", has_text="End session").click()
        page.wait_for_url(BASE); page.wait_for_timeout(800); shot("s09-start-again")
        line = page.inner_text("#welcome-last")
        print("   ", line)
        check("start page: Last Session ready, says what and where", not page.locator("#welcome-last-btn").is_disabled()
              and "05 - saved" in line and "slide 3 of 6" in line)
        page.click("#welcome-last-btn"); page.wait_for_url("**/s/**"); page.wait_for_timeout(4500); shot("s10-resumed")
        check("same session code (still on the server)", sid() == first)
        check("…the ?resume is gone from the address", "resume" not in page.url)
        st = page.evaluate("() => ({ n: window.beamerState.totalSlides, at: window.beamerState.currentSlide, ink: Object.keys(window.beamerState.annotations), name: document.getElementById('session-btn').innerText.trim(), target: window.beamerState.target })")
        print("   resumed:", st)
        check("…deck back, on slide 3", st["n"] == 6 and st["at"] == 2)
        check("…with the ink on slide 2", "1" in st["ink"])
        check("…and its place in the folder (Save goes back there)", st["name"] == "05 - saved" and st["target"] and st["target"]["dir"] == L)

        # 9. The server lost that session: Last Session opens it in a new one.
        page.evaluate(SET_LAST_SESSION, "ZZZZZZ")
        page.goto(BASE); page.wait_for_timeout(600)
        page.click("#welcome-last-btn"); page.wait_for_url("**/s/**"); page.wait_for_timeout(4500)
        check("gone from the server: a new session, deck back", sid() not in (first, "ZZZZZZ")
              and page.evaluate("() => window.beamerState.totalSlides") == 6)

        # 10. New Session starts empty (the kept copy stays for Last Session).
        page.goto(BASE); page.wait_for_timeout(600)
        page.click("#welcome-new-btn"); page.wait_for_url("**/s/**"); page.wait_for_timeout(2500)
        check("New Session: nothing open", not page.evaluate("() => !!window.beamerState.zipFile"))
        page.goto(BASE); page.wait_for_timeout(600)
        check("…Last Session still there", not page.locator("#welcome-last-btn").is_disabled())

        # 11. A browser without folders: Open is the file picker.
        ctx2 = b.new_context(viewport={"width": 1200, "height": 800})
        ctx2.add_init_script("delete window.showDirectoryPicker;")
        p2 = ctx2.new_page()
        p2.goto(BASE); p2.wait_for_timeout(500); p2.click("#welcome-new-btn"); p2.wait_for_url("**/s/**"); p2.wait_for_timeout(2200)
        with p2.expect_file_chooser(timeout=3000) as fc:
            p2.click("#session-btn"); p2.click(".session-menu [data-menu='open']")
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
