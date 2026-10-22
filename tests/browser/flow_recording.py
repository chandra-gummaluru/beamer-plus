"""Recordings split into parts, saving them to GitHub (and what happens when that
fails), and split view filling the stage.

  python app.py --http --port 5001        (in another terminal)
  python tests/browser/flow_recording.py  screenshots land in tests/browser/shots/

The tab is faked with a canvas full of noise, and parts are made to start
every ~600 KB instead of every 40 MB, so a few seconds of recording make
several parts.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from playwright.sync_api import sync_playwright  # noqa: E402
from flow_github import BASE, OUT, L, SIGN_IN, make_gh  # noqa: E402

FAKE_SCREEN = """
(() => {
  const c = document.createElement('canvas'); c.width = 640; c.height = 480;
  const g = c.getContext('2d');
  const paint = () => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 480);
    const d = g.createImageData(160, 120);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i+1] = d.data[i+2] = v; d.data[i+3] = 255; }
    g.putImageData(d, 240, 180);
  };
  setInterval(paint, 33);
  navigator.mediaDevices.getDisplayMedia = async () => { paint(); return c.captureStream(30); };
  localStorage.setItem('beamer-recorder-prefs', JSON.stringify({ mic: false, sound: false }));
})();
"""
METAS = """async () => {
  const db = await new Promise(r => { const q = indexedDB.open('beamer-recordings', 1); q.onsuccess = () => r(q.result); });
  const all = await new Promise(r => { const q = db.transaction('meta').objectStore('meta').getAll(); q.onsuccess = () => r(q.result); });
  const out = [];
  for (const m of all) {
    const rows = await new Promise(r => { const q = db.transaction('chunks').objectStore('chunks').index('recId').getAll(m.id); q.onsuccess = () => r(q.result); });
    rows.sort((a, b) => a.seq - b.seq);
    const head = rows.length ? new Uint8Array(await rows[0].blob.slice(0, 12).arrayBuffer()) : [];
    out.push({ ...m, head: Array.from(head) });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}"""
BIG_TAKE = """async () => {
  const db = await new Promise(r => { const q = indexedDB.open('beamer-recordings', 1); q.onsuccess = () => r(q.result); });
  const tx = db.transaction(['meta','chunks'], 'readwrite');
  tx.objectStore('meta').put({ id:'rec-big', sessionId:'old', deckName:'x', label:'Recording 9', fileName:'x - recording 9 (y).webm',
    mimeType:'video/webm', startedAt: Date.now() - 9e6, durationMs: 3e6, size: 150e6, status:'done', lecture: null });
  tx.objectStore('chunks').add({ recId:'rec-big', seq:0, blob: new Blob(['big'], {type:'video/webm'}) });
  await new Promise(r => tx.oncomplete = r);
}"""


FIT1 = """() => { const pane = document.getElementById('pdf-container'), r = pane.querySelector('canvas').getBoundingClientRect();
    return Math.max(r.width / (pane.clientWidth * 0.95), r.height / (pane.clientHeight * 0.95)); }"""


def playable(head):
    webm = head[:4] == [0x1A, 0x45, 0xDF, 0xA3]
    mp4 = bytes(head[4:8]) == b"ftyp"
    return webm or mp4


def run():
    gh = make_gh()
    priv = gh.repos["chandra-gummaluru/courses-private"]
    errors, checks = [], []
    fail_blobs = {"on": False}

    def check(name, ok):
        checks.append((name, bool(ok)))
        print(("PASS " if ok else "FAIL ") + name)

    def patch_recorder(route):
        r = route.fetch()
        body = r.text().replace("const ROTATE_AT = 40e6;", "const ROTATE_AT = 600e3;")
        route.fulfill(response=r, body=body)

    def blobs(route):
        if fail_blobs["on"] and route.request.method == "POST":
            route.fulfill(status=502, body='{"message":"Server Error"}', content_type="application/json")
        else:
            route.fallback()

    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1360, "height": 860}, accept_downloads=True)
        ctx.route("https://api.github.com/**", gh.handle)
        ctx.route("https://api.github.com/repos/*/*/git/blobs", blobs)
        ctx.route(re.compile(r".*/static/js/app/recorder\.js(\?.*)?$"), patch_recorder)
        ctx.add_init_script(FAKE_SCREEN)
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        shot = lambda n: page.screenshot(path=f"{OUT}/{n}.png")
        go = lambda name: (page.locator(".gh-files .gh-item", has_text=name).first.click(), page.wait_for_timeout(400))
        menu = lambda key: (page.click("#account-btn"), page.click(f".account-menu [data-menu='{key}']"))

        page.goto(BASE); page.wait_for_timeout(500)
        page.evaluate(SIGN_IN); page.reload(); page.wait_for_url("**/s/**", timeout=5000); page.wait_for_timeout(3200)
        page.select_option(".gh-lib select[data-repo]", "chandra-gummaluru/courses-private"); page.wait_for_timeout(1200)
        for n in ["csc258", "f26", "lectures", "05 - Binary Arithmetic", "05 - Binary Arithmetic.zip"]:
            go(n)
        page.wait_for_timeout(2500)

        # 1. Split view fills the stage straight away (no divider drag needed).
        fit0 = page.evaluate(FIT1)
        page.click("#split-toggle"); page.wait_for_timeout(1500); shot("r01-split")
        fit = page.evaluate("""() => ['pdf-container', 'pdf-container-2'].map(id => {
            const pane = document.getElementById(id), cv = pane.querySelector('canvas');
            const r = cv.getBoundingClientRect();
            return { w: r.width / (pane.clientWidth * 0.95), h: r.height / (pane.clientHeight * 0.95) };
        })""")
        print("   split fit:", fit)
        check("split view: both slides fill their pane (no extra side margins)",
              all(max(f["w"], f["h"]) > 0.97 for f in fit))
        page.click("#split-toggle"); page.wait_for_timeout(1200)
        fit1 = page.evaluate(FIT1)
        print("   single fit:", fit0, "->", fit1)
        check("leaving split view: the slide is back to its full size", abs(fit1 - fit0) < 0.01)

        # A view slide with its own ratio (34/66), then a split opened by hand:
        # the hand-made split is 50/50 again, not the view's 34/66.
        page.evaluate("""async () => {
            const s = window.beamerState;
            s.slideStructure.push({ type: 'view', viewId: 'vtest', left: 0, right: 2, ratio: 34 });
            const { bus } = await import('/static/js/core/events.js');
            bus.emit('nav:refresh');
            bus.emit('slide:goto', s.slideStructure.length - 1);
        }""")
        page.wait_for_timeout(2000)
        view_ratio = page.evaluate("() => window.beamerState.splitView && Math.round(window.beamerState.splitRatio)")
        page.evaluate("""async () => { const { bus } = await import('/static/js/core/events.js'); bus.emit('slide:goto', 1); }""")
        page.wait_for_timeout(1500)
        print("   after leaving the view: split", page.evaluate("() => [window.beamerState.splitView, window.beamerState.currentSlide]"))
        if page.evaluate("() => window.beamerState.splitView"):
            page.click("#split-toggle"); page.wait_for_timeout(1200)
        page.click("#split-toggle"); page.wait_for_timeout(1500); shot("r01b-split-after-view")
        ratio = page.evaluate("() => Math.round(window.beamerState.splitRatio)")
        fit = page.evaluate("""() => ['pdf-container', 'pdf-container-2'].map(id => {
            const pane = document.getElementById(id), r = pane.querySelector('canvas').getBoundingClientRect();
            return Math.max(r.width / (pane.clientWidth * 0.95), r.height / (pane.clientHeight * 0.95)); })""")
        print(f"   view ratio {view_ratio}, then manual split ratio {ratio}, fit {fit}")
        check("after a 34/66 view slide, a split you open is 50/50 and fills the stage",
              view_ratio == 34 and ratio == 50 and all(f > 0.97 for f in fit))
        page.click("#split-toggle"); page.wait_for_timeout(1200)
        page.evaluate("""() => { window.beamerState.slideStructure.pop(); }""")

        # 2. A long take is split into parts, each a complete file.
        page.click("#record-btn"); page.wait_for_timeout(300)
        page.locator(".custom-modal-btn", has_text="Start recording").click()
        page.wait_for_timeout(12000)
        page.click("#recorder-stop-btn"); page.wait_for_timeout(2500); shot("r02-stopped")
        metas = page.evaluate(METAS)
        for m in metas:
            print(f"   {m['label']:<28} {m['size']:>8} B  {m['durationMs']:>5} ms  {m['status']}  {m['fileName']}")
        check("the take was split into several parts", len(metas) >= 3)
        check("every part finished and saved", all(m["status"] == "done" and m["size"] > 0 for m in metas))
        check("each part is a complete file (starts with its own header)", all(playable(m["head"]) for m in metas))
        check("parts stay near the limit (start a new one at 600 KB)", all(m["size"] < 600e3 + 2 * max(1, m["size"] * 1000 / max(1, m["durationMs"])) for m in metas))
        check("parts are numbered: Recording 1 · part 1, 2, …",
              [m["label"] for m in metas] == [f"Recording 1 · part {i + 1}" for i in range(len(metas))])
        check("one take: same group, durations add up",
              len({m["group"] for m in metas}) == 1 and abs(sum(m["durationMs"] for m in metas) - 12000) < 2500)

        # 3. Saving to GitHub fails: nothing lost, try again or save to this computer.
        page.evaluate(BIG_TAKE)
        menu("save"); page.wait_for_timeout(1500); shot("r03-save")
        chip = " ".join(page.locator(".gh-chip", has_text="Recordings").inner_text().split())
        check(f"save offers every part ({chip})", chip == f"Recordings {len(metas)}")
        check("a take too big for GitHub is shown, with a way to download it",
              page.locator(".gh-toobig [data-toobig]").count() == 1 and "too big for GitHub" in page.inner_text(".gh-toobig"))
        fail_blobs["on"] = True
        page.click("[data-save]"); page.wait_for_timeout(4000); shot("r04-failed")
        btns = [x.inner_text().strip() for x in page.locator(".custom-modal-btn").all()]
        check(f"failed save: Close / Try again / Save to this computer ({btns})", btns == ["Close", "Try again", "Save to this computer"])
        check("…and says the recordings are still safe", "still in Beamer+" in page.inner_text(".custom-modal-overlay"))
        before = set(priv.files())
        got = []
        page.on("download", lambda d: got.append(d.suggested_filename))
        page.locator(".custom-modal-btn", has_text="Save to this computer").click()
        page.wait_for_timeout(1500 + 500 * len(metas))
        print("   downloaded:", got)
        check("save to this computer downloads everything that was built",
              "05 - Binary Arithmetic.zip" in got and sum(1 for g in got if re.search(r"-part\d+\.(webm|mp4)$", g)) == len(metas))
        check("nothing reached GitHub", set(priv.files()) == before)
        menu("save"); page.wait_for_timeout(1500)
        check("the parts are still offered for GitHub", " ".join(page.locator(".gh-chip", has_text="Recordings").inner_text().split()) == f"Recordings {len(metas)}")
        page.click("[data-save]"); page.wait_for_timeout(3000)
        page.locator(".custom-modal-btn", has_text="Try again").click()
        page.wait_for_timeout(1000)
        fail_blobs["on"] = False
        page.locator(".custom-modal-btn", has_text="Try again").click()
        page.wait_for_timeout(5000); shot("r05-saved")
        parts = sorted(k for k in priv.files() if re.match(rf"{re.escape(L)}/05 - Binary Arithmetic-\d{{4}}(-\d\d){{4}}-part\d+\.(webm|mp4)$", k))
        print("   on GitHub:", parts)
        check("try again saves every part to GitHub, numbered", len(parts) == len(metas))
        menu("save"); page.wait_for_timeout(1500)
        check("…and they aren't offered again", "Recordings" in page.inner_text(".gh-chips") and page.locator("[data-recs]").is_disabled())
        page.keyboard.press("Escape")

        b.close()
    errors = [e for e in errors if "ERR_TUNNEL" not in e and "502" not in e and "Server Error" not in e and "save failed" not in e]
    print("\nconsole errors:\n  " + "\n  ".join(errors) if errors else "\nno console errors")
    print(f"{sum(ok for _, ok in checks)}/{len(checks)} checks passed")
    return all(ok for _, ok in checks) and not errors


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
