"""Walk through the presenter / audience split in a real browser.

  python app.py --http --port 5001        (in another terminal)
  python tests/browser/flow_security.py

The presenter's browser opens a deck, runs a poll and gets its answers over
the socket; a second browser (a student's phone) can answer once, but can't
open the presenter view, read the deck, or see other answers.
"""
import base64
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from playwright.sync_api import sync_playwright  # noqa: E402
from common import BASE, make_pdf, make_zip, FAKE_FOLDER, FOLDER_RESET, FOLDER_PUT  # noqa: E402

DECK = "Security Check"


def run():
    checks = []

    def check(name, ok):
        checks.append((name, bool(ok)))
        print(("PASS " if ok else "FAIL ") + name)

    with sync_playwright() as p:
        b = p.chromium.launch()
        pres = b.new_context(viewport={"width": 1360, "height": 860})
        pres.add_init_script(FAKE_FOLDER)
        page = pres.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # The presenter: New Session, a deck opened.
        page.goto(BASE); page.wait_for_timeout(500)
        page.evaluate(FOLDER_RESET)
        page.evaluate(FOLDER_PUT, {f"d/{DECK}.zip": base64.b64encode(make_zip(make_pdf())).decode()})
        page.evaluate("p => { window.__open = p; }", f"Courses/d/{DECK}.zip")
        page.click("#welcome-new-btn"); page.wait_for_url("**/s/**")
        page.wait_for_function("() => window.beamerState?.totalSlides === 6", timeout=15000)
        sid = page.evaluate("() => window.BEAMER_SESSION_ID || location.pathname.split('/')[2]")
        base = BASE.rstrip("/")
        check("presenter: the session opens with its deck", page.evaluate("() => window.beamerState.totalSlides") == 6)
        cookies = {c["name"]: c for c in pres.cookies()}
        pc = cookies.get(f"bp_presenter_{sid}")
        check("…presenter cookie is HttpOnly", pc and pc["httpOnly"])
        check("…and not readable from the page", f"bp_presenter_{sid}" not in page.evaluate("() => document.cookie"))

        # A widget is a srcdoc iframe: its fetches must carry the cookie.
        made = page.evaluate("""async (sid) => {
            const f = document.createElement('iframe');
            const url = location.origin + '/s/' + sid + '/api/survey/create';
            f.srcdoc = `<script>fetch(${JSON.stringify(url)}, {method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({question:'Ready?', kind:'open'})}).then(r => r.json().then(j => parent.postMessage({made: j, status: r.status}, '*')));<\\/script>`;
            const got = new Promise(res => addEventListener('message', e => e.data && e.data.made && res(e.data)));
            document.body.appendChild(f);
            return await got;
        }""", sid)
        check("widget iframe: creates a poll (cookie sent from srcdoc)", made["status"] == 200)
        survey = made["made"]["survey_id"]

        # The presenter's socket joins its room (the AR widget does the same).
        page.add_script_tag(url="/static/vendor/socket.io.min.js")
        page.evaluate("""(sid) => {
            window.__answers = [];
            const s = io(location.origin, { transports: ['websocket', 'polling'] });
            s.on('connect', () => s.emit('join_presenter', { session_id: sid }));
            s.on('survey_response', d => window.__answers.push(d.response.text));
        }""", sid)
        page.wait_for_timeout(1000)

        # A student's phone.
        phone_ctx = b.new_context(viewport={"width": 390, "height": 800})
        phone = phone_ctx.new_page()
        phone.goto(f"{base}/s/{sid}/survey/{survey}")
        phone.wait_for_timeout(800)
        phone.evaluate("""(sid) => {
            window.__snooped = [];
            const s = io();
            s.on('connect', () => s.emit('join_presenter', { session_id: sid }));
            s.on('survey_response', d => window.__snooped.push(d));
        }""", sid)
        page.wait_for_timeout(500)
        post = """async ([sid, survey, text]) => (await fetch(`/s/${sid}/api/survey/${survey}/respond`,
            {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({response: text})})).status"""
        check("phone: answers", phone.evaluate(post, [sid, survey, "yes"]) == 200)
        check("…but only once", phone.evaluate(post, [sid, survey, "again"]) == 409)
        page.wait_for_timeout(800)
        check("presenter: gets the answer over the socket", page.evaluate("() => window.__answers") == ["yes"])
        check("phone: can't listen in on the presenter room", phone.evaluate("() => window.__snooped.length") == 0)

        get = "async (u) => (await fetch(u)).status"
        check("phone: can't read the answers", phone.evaluate(get, f"/s/{sid}/api/survey/{survey}/responses") == 403)
        check("phone: can't read the deck", phone.evaluate(get, f"/s/{sid}/api/zip-asset/slides.pdf") == 403)
        phone.goto(f"{base}/s/{sid}/")
        check("phone: presenter view refused", "open in another browser" in phone.content())
        check("…and has no session in it", not phone.evaluate("() => !!window.beamerState"))

        # Close session ends it on the server.
        page.click("#session-close-btn"); page.wait_for_timeout(800)
        dont = page.locator("button", has_text="Save").filter(has_text="Don")
        if dont.count():
            dont.first.click()
        page.wait_for_url(BASE, timeout=10000); page.wait_for_timeout(500)
        r = phone.goto(f"{base}/s/{sid}/survey/{survey}")
        check("closed: the session is gone", r.status == 404)
        check("no page errors", not errors)
        if errors:
            print("  ", errors[:5])
        b.close()

    failed = [n for n, ok in checks if not ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(run())
