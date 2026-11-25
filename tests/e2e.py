#!/usr/bin/env python3
"""End-to-end checks for the portfolio. Standard library only.

Run from the project root:   python3 -I tests/e2e.py
Needs Google Chrome (or Chromium) installed. Starts its own static server on a free port,
drives headless Chrome through the DevTools protocol, and mocks api.github.com for the
owner sign-in / save checks (no real token or network access is used).

Set E2E_SCREENSHOTS=<dir> to also save full-page screenshots at 1200px and 390px.
"""
import base64, functools, http.server, json, os, re, shutil, socket, struct, subprocess
import sys, tempfile, threading, time, traceback, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSP = ("default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
       "font-src https://fonts.gstatic.com; img-src 'self' blob:; connect-src 'self' https://api.github.com; "
       "base-uri 'none'; form-action 'none'; object-src 'none'")
OWNER_ONLY_JS = ("/js/editor.js", "/js/auth.js", "/js/github.js", "/js/dialog.js")
NAV = [("overview", "Overview"), ("skills", "Skills"), ("experience", "Experience"),
       ("education", "Education"), ("work", "Projects & Documents"), ("contact", "Contact")]

# ---------------------------------------------------------------------------
# Minimal WebSocket + Chrome DevTools Protocol client
# ---------------------------------------------------------------------------
class WS:
    def __init__(self, url):
        hostport, path = url[len("ws://"):].split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        head, self.rest = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise RuntimeError("WebSocket handshake failed: " + head.decode(errors="replace"))

    def _read(self, n):
        while len(self.rest) < n:
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise ConnectionError("DevTools connection closed")
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def send(self, text):
        data, mask = text.encode(), os.urandom(4)
        n = len(data)
        hdr = (struct.pack("!BB", 0x81, 0x80 | n) if n < 126 else
               struct.pack("!BBH", 0x81, 0xFE, n) if n < 65536 else struct.pack("!BBQ", 0x81, 0xFF, n))
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
        self.sock.sendall(hdr + mask + masked)

    def recv(self):
        msg = b""
        while True:
            b1, b2 = self._read(2)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            payload, op = self._read(n), b1 & 0x0F
            if op == 8:
                raise ConnectionError("DevTools connection closed")
            if op in (9, 10):
                continue
            msg += payload
            if b1 & 0x80:
                return msg.decode()


def find_chrome():
    for c in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "/Applications/Chromium.app/Contents/MacOS/Chromium",
              shutil.which("google-chrome"), shutil.which("google-chrome-stable"),
              shutil.which("chromium"), shutil.which("chromium-browser")):
        if c and os.path.exists(c):
            return c
    sys.exit("Google Chrome / Chromium not found.")


class Browser:
    def __init__(self):
        self.profile = tempfile.mkdtemp(prefix="e2e-chrome-")
        self.proc = subprocess.Popen(
            [find_chrome(), "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={self.profile}",
             "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
             "--window-size=1200,900", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        port_file = os.path.join(self.profile, "DevToolsActivePort")
        for _ in range(300):
            if os.path.exists(port_file) and open(port_file).read().strip():
                break
            time.sleep(0.05)
        port = open(port_file).read().split()[0]
        targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list"))
        self.ws = WS(next(t for t in targets if t["type"] == "page")["webSocketDebuggerUrl"])
        self.next_id, self.events, self.on_request = 0, [], None
        for domain in ("Page", "Runtime", "Log", "Network"):
            self.cmd(f"{domain}.enable")
        self.cmd("Network.setCacheDisabled", cacheDisabled=True)

    def _handle(self, m):
        if m.get("method") == "Fetch.requestPaused" and self.on_request:
            self.on_request(self, m["params"])
        else:
            self.events.append(m)

    def send(self, method, **params):
        self.next_id += 1
        self.ws.send(json.dumps({"id": self.next_id, "method": method, "params": params}))
        return self.next_id

    def cmd(self, method, **params):
        mid = self.send(method, **params)
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == mid:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})
            if "method" in m:
                self._handle(m)

    def viewport(self, width, height=900):
        self.cmd("Emulation.setDeviceMetricsOverride", width=width, height=height, deviceScaleFactor=1, mobile=width < 500)

    def js(self, expr):
        r = self.cmd("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True, userGesture=True)
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise RuntimeError(d.get("exception", {}).get("description") or d.get("text"))
        return r["result"].get("value")

    def wait(self, expr, timeout=10):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            try:
                if self.js(f"Boolean({expr})"):
                    return True
            except RuntimeError as e:
                last = e
            time.sleep(0.05)
        raise TimeoutError(f"timed out waiting for {expr}" + (f" ({last})" if last else ""))

    def goto(self, url):
        self.events.clear()
        self.cmd("Page.navigate", url=url)
        self.wait("document.readyState === 'complete' && document.querySelector('#overview h1')")
        self.js("document.fonts.ready.then(() => true)")

    def sleep(self, seconds):
        end = time.time() + seconds
        while time.time() < end:  # keep pumping events (e.g. intercepted requests)
            self.js("1")
            time.sleep(0.03)

    def mouse(self, x, y, kind="mouseMoved"):
        self.cmd("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left" if kind != "mouseMoved" else "none", clickCount=1)

    def key(self, key, code, vk):
        self.cmd("Input.dispatchKeyEvent", type="keyDown", key=key, code=code, windowsVirtualKeyCode=vk)
        self.cmd("Input.dispatchKeyEvent", type="keyUp", key=key, code=code, windowsVirtualKeyCode=vk)

    def screenshot(self, path):
        w = self.js("document.documentElement.clientWidth")
        h = self.js("document.documentElement.scrollHeight")
        data = self.cmd("Page.captureScreenshot", format="png", captureBeyondViewport=True,
                        clip={"x": 0, "y": 0, "width": w, "height": h, "scale": 1})["data"]
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))

    def console_errors(self):
        out = []
        for e in self.events:
            m, p = e.get("method"), e.get("params", {})
            if m == "Runtime.exceptionThrown":
                out.append(p["exceptionDetails"].get("exception", {}).get("description", "exception"))
            elif m == "Log.entryAdded" and p["entry"]["level"] == "error":
                if "favicon.ico" not in p["entry"].get("url", ""):
                    out.append(p["entry"]["text"] + " " + p["entry"].get("url", ""))
            elif m == "Runtime.consoleAPICalled" and p["type"] == "error":
                out.append(" ".join(str(a.get("value", a.get("description", ""))) for a in p["args"]))
        return out

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)


# ---------------------------------------------------------------------------
# Static server + check bookkeeping
# ---------------------------------------------------------------------------
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def start_server():
    handler = functools.partial(QuietHandler, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/"


RESULTS = []


def check(name, fn):
    try:
        ok = fn()
        detail = ""
        if isinstance(ok, tuple):
            ok, detail = ok
        RESULTS.append((name, bool(ok), detail))
    except Exception as e:  # a crashing check is a failing check
        RESULTS.append((name, False, f"{type(e).__name__}: {e}"))
    status = "PASS" if RESULTS[-1][1] else "FAIL"
    print(f"  {status}  {name}" + (f"  — {RESULTS[-1][2]}" if not RESULTS[-1][1] and RESULTS[-1][2] else ""))


def rgb(s):
    nums = [float(x) for x in re.findall(r"[\d.]+", s)[:3]]
    return tuple(nums)


def contrast(c1, c2):
    def lum(c):
        def ch(v):
            v /= 255
            return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
        r, g, b = (ch(v) for v in c)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    a, b = sorted((lum(c1), lum(c2)), reverse=True)
    return (a + 0.05) / (b + 0.05)


# Text-node walker used for the "everything editable" checks.
# mode "edit": every non-blank text node in <main> must be inside [contenteditable], except the
# editor's own buttons and dialogs. mode "view": inside [data-edit] (what the editor will make editable).
WALK_JS = r"""(mode => {
  const bad = [];
  const w = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    if (!n.textContent.trim()) continue;
    const p = n.parentElement;
    if (mode === 'edit') {
      if (p.closest('[contenteditable]')) continue;
      if (p.closest('button.ed-btn, button.ed-add, [data-editor-ui], dialog')) continue;
    } else if (p.closest('[data-edit]')) continue;
    bad.push(n.textContent.trim().slice(0, 40));
  }
  return bad;
})"""


# ---------------------------------------------------------------------------
# Mock GitHub API (owner tests only)
# ---------------------------------------------------------------------------
class MockGitHub:
    def __init__(self):
        self.calls = []
        self.data_json = open(os.path.join(ROOT, "data.json"), encoding="utf-8").read()
        cfg = open(os.path.join(ROOT, "config.js"), encoding="utf-8").read()
        self.config_js = re.sub(r'owner:\s*"[^"]*"', 'owner: "test-owner"', cfg)
        self.config_js = re.sub(r'repo:\s*"[^"]*"', 'repo: "test-repo"', self.config_js)

    CORS = [
        {"name": "Access-Control-Allow-Origin", "value": "*"},
        {"name": "Access-Control-Allow-Headers", "value": "Authorization, Accept, Content-Type, X-GitHub-Api-Version"},
        {"name": "Access-Control-Allow-Methods", "value": "GET, POST, PATCH, OPTIONS"},
    ]

    def __call__(self, browser, p):
        req, rid = p["request"], p["requestId"]
        url, method = req["url"], req["method"]

        def reply(status, body="", ctype="application/json"):
            browser.send("Fetch.fulfillRequest", requestId=rid, responseCode=status,
                         responseHeaders=self.CORS + [{"name": "Content-Type", "value": ctype}],
                         body=base64.b64encode(body.encode()).decode())

        if url.split("?")[0].endswith("/config.js"):
            return reply(200, self.config_js, "text/javascript")
        if "api.github.com" not in url:
            return browser.send("Fetch.continueRequest", requestId=rid)
        if method == "OPTIONS":
            return reply(204)
        self.calls.append({"method": method, "url": url, "auth": req["headers"].get("Authorization", ""),
                           "body": req.get("postData", "")})
        path = url.split("api.github.com", 1)[1].split("?")[0]
        base = "/repos/test-owner/test-repo"
        if req["headers"].get("Authorization") != "Bearer good-token":
            return reply(401, json.dumps({"message": "Bad credentials"}))
        if method == "GET" and path == base:
            return reply(200, json.dumps({"full_name": "test-owner/test-repo", "permissions": {"push": True}}))
        if method == "GET" and path == f"{base}/contents/data.json":
            return reply(200, self.data_json)
        if method == "GET" and path == f"{base}/git/ref/heads/main":
            return reply(200, json.dumps({"object": {"sha": "head1"}}))
        if method == "GET" and path == f"{base}/git/commits/head1":
            return reply(200, json.dumps({"tree": {"sha": "tree1"}}))
        if method == "POST" and path == f"{base}/git/blobs":
            return reply(201, json.dumps({"sha": f"blob{len(self.calls)}"}))
        if method == "POST" and path == f"{base}/git/trees":
            return reply(201, json.dumps({"sha": "tree2"}))
        if method == "POST" and path == f"{base}/git/commits":
            return reply(201, json.dumps({"sha": "commit2"}))
        if method == "PATCH" and path == f"{base}/git/refs/heads/main":
            return reply(200, json.dumps({"object": {"sha": "commit2"}}))
        return reply(404, json.dumps({"message": "Not Found"}))


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
def visitor_checks(b, url):
    print("\nVisitor view · 1200px")
    b.viewport(1200)
    b.goto(url)
    data = json.load(open(os.path.join(ROOT, "data.json"), encoding="utf-8"))
    html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    css = open(os.path.join(ROOT, "css", "styles.css"), encoding="utf-8").read()

    check("page renders without console errors", lambda: (not b.console_errors(), b.console_errors()))
    check("document title uses the profile name", lambda: b.js("document.title").startswith(data["profile"]["name"]))
    check("CSP meta tag is unchanged", lambda: b.js(
        "document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]').content.replace(/\\s+/g,' ').trim()") == CSP)
    check("no inline scripts or style attributes in index.html", lambda: (
        not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html) and " style=" not in html))
    check("editor/auth/github/dialog code is not loaded for visitors", lambda: (
        lambda loaded: (not any(p in loaded for p in OWNER_ONLY_JS), loaded))(
        b.js("performance.getEntriesByType('resource').map(e => new URL(e.name).pathname)")))

    # --- Item 10: sections
    check("six sections in order: overview, skills, experience, education, work, contact", lambda: b.js(
        "[...document.querySelectorAll('main > section')].map(s => s.id).join()") == "overview,skills,experience,education,work,contact")
    check("old combined #background section is gone", lambda: b.js("!document.getElementById('background')"))
    check("every section is labelled by its heading", lambda: b.js(
        "[...document.querySelectorAll('main > section')].every(s => document.getElementById(s.getAttribute('aria-labelledby')))"))

    # --- Item 1: nav under the avatar
    check("topbar holds only the brand and the pencil (no nav)", lambda: b.js(
        "!document.querySelector('.topbar nav') && document.querySelector('.topbar__inner').children.length === 2 "
        "&& !!document.querySelector('.topbar #brand') && !!document.querySelector('.topbar #owner-login')"))
    check("nav is rendered inside #overview, after the avatar", lambda: b.js(
        "(() => { const nav = document.querySelector('#overview .hero__side nav[data-nav]'); const av = document.querySelector('#overview .avatar');"
        " return !!nav && !!av && !!(av.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING); })()"))
    check("nav has the six links, labels from data.nav", lambda: (
        lambda got: (got == [[f"#{i}", l] for i, l in NAV], got))(
        b.js("[...document.querySelectorAll('[data-nav] a')].map(a => [a.getAttribute('href'), a.textContent])")))
    check("nav targets all exist", lambda: b.js(
        "[...document.querySelectorAll('[data-nav] a')].every(a => document.getElementById(a.getAttribute('href').slice(1)))"))
    check("nav is a vertical list on wide screens", lambda: b.js(
        "(() => { const r = [...document.querySelectorAll('[data-nav] a')].map(a => a.getBoundingClientRect());"
        " return r.every((x, i) => i === 0 || (x.top > r[i-1].top && Math.abs(x.left - r[0].left) < 1)); })()"))

    def sticky():
        b.js("window.scrollTo({top: document.documentElement.scrollHeight / 2, behavior: 'instant'})")
        b.sleep(0.2)
        r = b.js("(() => { const r = document.querySelector('[data-nav]').getBoundingClientRect(); return [r.top, r.bottom, innerHeight, getComputedStyle(document.querySelector('.hero__side')).position]; })()")
        return (r[3] == "sticky" and r[0] >= 0 and r[1] <= r[2], r)
    check("nav stays in view (sticky) while scrolling on wide screens", sticky)

    def highlight(section_id):
        def run():
            b.js(f"document.getElementById('{section_id}').scrollIntoView({{behavior: 'instant'}})")
            b.wait(f"document.querySelector('[data-nav] a.is-active')?.getAttribute('href') === '#{section_id}'", 4)
            return True
        return run
    check("nav highlights the section in view (experience)", highlight("experience"))

    def bottom():
        b.js("window.scrollTo({top: document.documentElement.scrollHeight, behavior: 'instant'})")
        b.wait("document.querySelector('[data-nav] a.is-active')?.getAttribute('href') === '#contact'", 4)
        return True
    check("nav highlights Contact at the bottom of the page", bottom)

    def after_rerender():
        b.js("Promise.all([import('/js/render.js'), import('/js/state.js')]).then(([r, s]) => r.renderAll(s.state.data))")
        b.js("window.scrollTo({top: 0, behavior: 'instant'})")
        b.sleep(0.2)
        return highlight("education")()
    check("nav highlighting still works after renderAll() rebuilds the DOM", after_rerender)
    b.js("window.scrollTo({top: 0, behavior: 'instant'})")

    # --- Items 5 + 9: pencil button
    check("pencil button: id, class, aria-label, tooltip text, inline SVG", lambda: b.js(
        "(() => { const btn = document.getElementById('owner-login'); return btn.tagName === 'BUTTON' && btn.classList.contains('edit-fab')"
        " && btn.getAttribute('aria-label') === 'Sign in to edit' && btn.dataset.tooltip === 'sign in to edit' && !!btn.querySelector('svg'); })()"))
    check("old footer owner link is gone", lambda: b.js("!document.querySelector('footer #owner-login, .linklike')"))

    def visible_btn():
        r = b.js("(() => { const r = document.getElementById('owner-login').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, innerWidth, innerHeight]; })()")
        return (r[0] >= 0 and r[1] >= 0 and r[2] <= r[4] and r[3] <= r[5] and r[2] - r[0] >= 32, r)
    check("pencil is visible without scrolling at 1200px", visible_btn)

    def tooltip_hover():
        x, y = b.js("(() => { const r = document.getElementById('owner-login').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
        b.mouse(x, y)
        b.sleep(0.35)
        st = b.js("(() => { const s = getComputedStyle(document.getElementById('owner-login'), '::after'); return [s.content, s.visibility, s.opacity]; })()")
        b.mouse(5, 600)
        return (st == ['"sign in to edit"', "visible", "1"], st)
    check("tooltip reads exactly 'sign in to edit' on hover", tooltip_hover)

    def tooltip_focus():
        b.goto(url)
        b.js("window.scrollTo(0, 0)")
        for _ in range(8):
            b.key("Tab", "Tab", 9)
            if b.js("document.activeElement.id") == "owner-login":
                break
        b.sleep(0.35)
        st = b.js("(() => { const btn = document.getElementById('owner-login'); const s = getComputedStyle(btn, '::after');"
                  " return [document.activeElement === btn, btn.matches(':focus-visible'), s.content, s.visibility, s.opacity]; })()")
        return (st == [True, True, '"sign in to edit"', "visible", "1"], st)
    check("tooltip shows 'sign in to edit' on keyboard focus", tooltip_focus)

    def unconfigured_click():
        b.goto(url)
        b.js("document.getElementById('owner-login').click()")
        b.wait("document.querySelector('dialog[open]')")
        title = b.js("document.querySelector('dialog[open] h2').textContent")
        loaded = b.js("performance.getEntriesByType('resource').map(e => new URL(e.name).pathname)")
        b.js("document.querySelector('dialog[open]').close()")
        # "Owner sign-in" when config.js names a repo, "…not set up yet" while it still has the placeholder
        return ("/js/auth.js" in loaded and "/js/editor.js" not in loaded
                and ("not set up" in title or title == "Owner sign-in"), (title, loaded))
    check("pencil imports auth.js on click (editor.js still not loaded without a token)", unconfigured_click)

    # --- Item 2: one typeface
    check("Newsreader removed from HTML and CSS", lambda: "Newsreader" not in html and "Newsreader" not in css and "--font-name" not in css)
    check("Plus Jakarta Sans used for body, brand, name and avatar", lambda: b.js(
        "['body', '.brand', '#overview h1', '.avatar', '.section__title'].every(s => getComputedStyle(document.querySelector(s)).fontFamily.startsWith('\"Plus Jakarta Sans\"'))"))

    # --- Item 3: panels and tokens
    check("page background is the cool #F4F7FB token", lambda: b.js("getComputedStyle(document.body).backgroundColor") == "rgb(244, 247, 251)")

    def panels():
        r = b.js("""[...document.querySelectorAll('main > .section:not(#overview), #overview > .hero__side, #overview > .hero__body')].map(p => {
          const s = getComputedStyle(p);
          return [s.backgroundColor, s.borderTopWidth, s.borderTopStyle, s.borderTopColor, s.borderTopLeftRadius, s.boxShadow !== 'none', s.paddingTop];
        })""")
        ok = len(r) == 7 and all(x[0] == "rgb(255, 255, 255)" and x[1] == "1px" and x[2] == "solid" and x[3] == "rgb(220, 227, 238)"
                                 and float(x[4][:-2]) > 0 and x[5] for x in r) and len({x[6] for x in r}) == 1
        return (ok, r)
    check("every section is a white panel: 1px #DCE3EE border, radius, shadow, shared padding", panels)
    check("panels are separated by one consistent gap", lambda: (lambda gaps: (len(set(gaps)) == 1 and gaps[0] > 0, gaps))(b.js(
        "(() => { const ps = [...document.querySelectorAll('#overview > .hero__body, main > .section:not(#overview)')].map(p => p.getBoundingClientRect());"
        " return ps.slice(1).map((r, i) => Math.round(r.top - ps[i].bottom)); })()")))
    check("old section divider lines are gone (no bottom-border rule)", lambda: "border-bottom: 1px solid var(--line); scroll-margin" not in css
          and b.js("getComputedStyle(document.getElementById('skills')).borderBottomWidth") == "1px")
    check("Contact min-height rule removed; main has bottom padding", lambda: (
        ".section:last-child" not in css and b.js("getComputedStyle(document.getElementById('contact')).minHeight") in ("auto", "0px")
        and float(b.js("getComputedStyle(document.querySelector('main')).paddingBottom")[:-2]) > 0))
    check("hardcoded topbar / edit-focus colours replaced with tokens", lambda: (
        "rgba(250, 247, 242" not in css and "#fffdf7" not in css.lower()
        and "background: var(--topbar-bg)" in css and "background: var(--edit-focus-bg)" in css))
    check("plum accents kept", lambda: all(c in css for c in ("#6D3B6E", "#562D57", "#F6EFF6")))

    # --- Item 4: pills
    def pill_contrast():
        pairs = b.js("[...document.querySelectorAll('.tag, .chip, .doc__kind')].map(p => { const s = getComputedStyle(p); return [p.textContent.slice(0, 20), s.color, s.backgroundColor]; })")
        worst = min((contrast(rgb(c), rgb(bg)), t) for t, c, bg in pairs)
        return (len(pairs) > 20 and worst[0] >= 4.5, f"{len(pairs)} pills, lowest {worst[0]:.2f}:1 ({worst[1]})")
    check("every pill's text/background contrast is at least 4.5:1 (WCAG AA)", pill_contrast)

    def pill_contexts():
        r = b.js("""(() => {
          const pick = sel => { const p = document.querySelector(sel); const s = getComputedStyle(p);
            return [s.backgroundColor, s.borderTopColor, s.borderTopWidth, s.borderTopStyle, s.color]; };
          return { skills: pick('[data-pill="skills"] .tag'), tags: pick('[data-pill="tags"] .tag'),
                   kind: pick('.chip[data-pill="kind"]'), docs: pick('.doc__kind[data-pill="docs"]') };
        })()""")
        bgs = {v[0] for v in r.values()}
        ok = (len(bgs) == 4 and all(v[2] == "1px" and v[3] == "solid" and v[4] == "rgb(30, 41, 59)" for v in r.values()))
        return (ok, r)
    check("four pill contexts with distinct tints, 1px border, slate text", pill_contexts)

    # --- Item 6: icon buttons
    def socials():
        r = b.js("""[...document.querySelectorAll('#overview .hero__body .socials > a')].map(a => {
          const s = getComputedStyle(a); const rc = a.getBoundingClientRect();
          return { cls: a.className, label: a.getAttribute('aria-label'), rel: a.getAttribute('rel'), target: a.getAttribute('target'),
                   href: a.getAttribute('href'), url: a.dataset.url, round: s.borderTopLeftRadius === '50%' || parseFloat(s.borderTopLeftRadius) >= rc.width / 2,
                   w: rc.width, h: rc.height, svg: !!a.querySelector('svg'), bg: s.backgroundColor };
        })""")
        kinds = [re.search(r"social--(\w+)", x["cls"]).group(1) for x in r]
        ok = kinds == ["linkedin", "email", "cv", "github"]
        ok &= all(x["label"] and x["rel"] == "noopener noreferrer" and x["round"] and x["svg"] and x["w"] == x["h"] >= 40 for x in r)
        ok &= [x["url"] for x in r] == ["profile.linkedin", "profile.email", "profile.cv", "profile.github"]
        return (ok, r)
    check("four round icon buttons (LinkedIn, Email, CV, GitHub) with aria-label and rel", socials)
    check("external icon links open in a new tab, mailto: does not", lambda: b.js(
        "(() => { const [li, em, cv, gh] = document.querySelectorAll('.socials > a');"
        " return li.target === '_blank' && cv.target === '_blank' && gh.target === '_blank' && !em.hasAttribute('target')"
        f" && em.getAttribute('href') === 'mailto:{data['profile']['email']}' && li.getAttribute('href') === {json.dumps(data['profile']['linkedin'])}; }})()"))
    check("CV button is dark sage #4B6455, GitHub is near-black with a white mark", lambda: b.js(
        "(() => { const cv = getComputedStyle(document.querySelector('.social--cv')); const gh = getComputedStyle(document.querySelector('.social--github'));"
        " return cv.backgroundColor === 'rgb(75, 100, 85)' && gh.color === 'rgb(255, 255, 255)'"
        " && gh.backgroundColor.match(/\\d+/g).slice(0, 3).every(v => +v <= 48); })()"))
    check("GitHub and CV show visible Placeholder badges", lambda: b.js(
        "['profile.githubPlaceholder', 'profile.cvPlaceholder'].every(p => { const e = document.querySelector(`[data-badge=\"${p}\"]`); return e && e.offsetParent && /placeholder/i.test(e.textContent); })"))

    # --- Item 7: justified body text
    check("body text justified with hyphenation; headings, nav, pills and dates are not", lambda: b.js(
        """(() => {
          const j = s => [...document.querySelectorAll(s)].every(e => { const c = getComputedStyle(e); return c.textAlign === 'justify' && c.hyphens === 'auto'; });
          const n = s => [...document.querySelectorAll(s)].every(e => getComputedStyle(e).textAlign !== 'justify');
          return j('.bio') && j('.project__summary') && j('.doc__note') && j('#experience .entry__bullets li') && j('#education .entry__bullets li') && j('.contact__intro')
            && n('h1, h2, h3') && n('[data-nav] a') && n('.tag, .chip, .doc__kind') && n('.btn') && n('.entry__dates');
        })()"""))

    # --- Item 10: CV content and layout
    check("Experience panel heading is EMPLOYMENT (uppercase)", lambda: b.js(
        "(() => { const h = document.getElementById('experience-heading'); return h.textContent === 'Employment' && getComputedStyle(h).textTransform === 'uppercase'; })()"))
    check("employment entries match the CV", lambda: (lambda got: (got == [
        ["Research Scholar", "Koci Laboratory, NCSU", "USA"], ["Team Leader", "Ole & Steen", "UK"],
        ["Swim Teacher & Lifeguard", "Everyone Active & Fun Flippers", "UK"]], got))(
        b.js("[...document.querySelectorAll('[data-collection=\"experience\"] > .entry')].map(e => [...e.querySelectorAll('.entry__title > span')].map(s => s.textContent))")))
    check("entry titles read 'Title – Organisation, Place' (separators from CSS)", lambda: b.js(
        "(() => { const e = document.querySelector('#experience .entry'); const b = (s, p) => getComputedStyle(e.querySelector(s), p).content;"
        " return b('.entry__org', '::before') === '\" – \"' &&b('.entry__place', '::before') === '\", \"'; })()"))
    check("dates are right-aligned beside the title on wide screens", lambda: b.js(
        "[...document.querySelectorAll('#experience .entry, #education .entry')].every(e => { const h = e.querySelector('.entry__head').getBoundingClientRect();"
        " const d = e.querySelector('.entry__dates').getBoundingClientRect(); const t = e.querySelector('.entry__title').getBoundingClientRect();"
        " return Math.abs(d.right - h.right) < 1 && d.top < t.bottom; })"))
    check("Additional experience lists MARS Work Experience", lambda: b.js(
        "(() => { const h = document.getElementById('additional-heading'); const e = document.querySelector('[data-collection=\"additional\"] .entry');"
        " return /additional experience/i.test(h.textContent) && e.querySelector('.entry__role').textContent === 'MARS Work Experience' && e.querySelectorAll('.entry__bullets li').length === 2; })()"))
    check("Education panel: BSc (Hons) Biochemistry – University of Surrey with CV bullets and dissertation", lambda: b.js(
        "(() => { const e = document.querySelector('#education .entry'); const lis = [...e.querySelectorAll('.entry__bullets li')].map(l => l.textContent);"
        " return document.getElementById('education-heading').textContent === 'Education' && e.querySelector('.entry__role').textContent === 'BSc (Hons) Biochemistry'"
        " && e.querySelector('.entry__org').textContent === 'University of Surrey' && lis.length === 5 && lis.some(t => t.startsWith('Dissertation (Grant Proposal)')); })()"))
    check("CV key skills line is skills data", lambda: b.js(
        "(() => { const g = document.querySelector('[data-item=\"skills.0\"]'); const items = [...g.querySelectorAll('.tag')].map(t => t.textContent);"
        " return g.querySelector('h3').textContent === 'Key skills' && ['Leadership','Research','Organisation','Time Management','Team Collaboration','Adaptability','Communication'].every(s => items.includes(s)); })()"))
    check("conference abstract citations on the matching project cards", lambda: b.js(
        "(() => { const c = i => document.querySelector(`[data-item=\"projects.${i}\"] .citations`).textContent;"
        " return c(0).includes('Abstract 423P, p. 194') && c(0).includes('Abstract 3, p. 5') && c(2).includes('Abstract P062, p. 64'); })()"))
    check("contact email is the CV address", lambda: b.js("document.querySelector('#contact [data-email] span').textContent") == "tamaraapen02@gmail.com")

    # --- Item 8 (visitor side) + general safety
    check("every visible text node in <main> comes from data (has data-edit)", lambda: (lambda bad: (not bad, bad))(b.js(f"{WALK_JS}('view')")))
    check("all target=_blank links have rel=noopener noreferrer", lambda: b.js(
        "[...document.querySelectorAll('a[target=_blank]')].every(a => a.rel === 'noopener noreferrer')"))

    if os.environ.get("E2E_SCREENSHOTS"):
        b.goto(url)
        b.screenshot(os.path.join(os.environ["E2E_SCREENSHOTS"], "portfolio-1200.png"))

    # --- 390px
    print("\nVisitor view · 390px")
    b.viewport(390, 844)
    b.goto(url)
    check("pencil is visible without scrolling at 390px", visible_btn)
    check("nav is a horizontally scrolling row on mobile", lambda: b.js(
        "(() => { const nav = document.querySelector('[data-nav]'); const r = [...nav.querySelectorAll('a')].map(a => a.getBoundingClientRect().top);"
        " return getComputedStyle(nav).overflowX === 'auto' && nav.scrollWidth > nav.clientWidth && r.every(t => Math.abs(t - r[0]) < 1); })()"))
    check("no horizontal page overflow at 390px", lambda: b.js("document.documentElement.scrollWidth <= innerWidth"))
    check("pencil tooltip stays inside the viewport at 390px", lambda: b.js(
        "(() => { const btn = document.getElementById('owner-login'); const r = btn.getBoundingClientRect(); const s = getComputedStyle(btn, '::after');"
        " return r.right - parseFloat(s.width) >= 0 && r.right <= innerWidth; })()"))
    if os.environ.get("E2E_SCREENSHOTS"):
        b.screenshot(os.path.join(os.environ["E2E_SCREENSHOTS"], "portfolio-390.png"))


def owner_checks(b, url):
    print("\nOwner mode (GitHub API mocked)")
    mock = MockGitHub()
    b.on_request = mock
    b.cmd("Fetch.enable", patterns=[{"urlPattern": "*api.github.com*"}, {"urlPattern": "*/config.js*"}])
    b.viewport(1200)
    b.goto(url)

    def sign_in_dialog():
        b.js("document.getElementById('owner-login').click()")
        b.wait("document.querySelector('dialog[open] input')")
        inputs = b.js("[...document.querySelectorAll('dialog[open] input')].map(i => i.type)")
        return (inputs == ["password"], inputs)
    check("sign-in asks for a GitHub token only (single password field)", sign_in_dialog)

    def bad_token():
        b.js("(() => { const i = document.querySelector('dialog[open] input'); i.value = 'wrong'; document.querySelector('dialog[open] .dlg__actions .btn:not(.btn--ghost)').click(); })()")
        b.wait("!document.querySelector('dialog[open] .dlg__err').hidden")
        return b.js("!document.body.classList.contains('editing') && !sessionStorage.getItem('tp_owner_token')"
                    " && !performance.getEntriesByType('resource').some(e => e.name.endsWith('/js/editor.js'))")
    check("a rejected token shows an error and does not load editor.js", bad_token)

    def good_token():
        b.js("(() => { const i = document.querySelector('dialog[open] input'); i.value = 'good-token'; document.querySelector('dialog[open] .dlg__actions .btn:not(.btn--ghost)').click(); })()")
        b.wait("document.querySelector('.ownerbar')")
        b.wait("document.body.classList.contains('editing')")
        return b.js("document.getElementById('owner-login').getAttribute('aria-pressed') === 'true'")
    check("after sign-in, edit mode is switched on automatically", good_token)
    check("token kept in sessionStorage only", lambda: b.js(
        "sessionStorage.getItem('tp_owner_token') === 'good-token' && !Object.values(localStorage).some(v => v.includes('good-token'))"))
    check("pencil stays visible and keeps the owner-login id", lambda: b.js(
        "(() => { const b = document.getElementById('owner-login'); return !b.hidden && b.getBoundingClientRect().top >= 0 && b.getBoundingClientRect().width > 30; })()"))
    check("owner bar keeps Save, Export and Log out (toggle moved to the pencil)", lambda: (lambda t: (t == ["Save changes", "Export JSON", "Log out"], t))(
        b.js("[...document.querySelectorAll('.ownerbar button')].map(x => x.textContent)")))

    def toggle():
        b.js("document.getElementById('owner-login').click()")
        off = b.js("!document.body.classList.contains('editing') && document.getElementById('owner-login').getAttribute('aria-pressed') === 'false' && !document.querySelector('main [contenteditable]')")
        b.js("document.getElementById('owner-login').click()")
        on = b.js("document.body.classList.contains('editing') && !!document.querySelector('main [contenteditable]')")
        return (off and on, (off, on))
    check("pencil toggles edit mode off and on", toggle)

    check("every text node in <main> is editable in edit mode (except editor buttons/dialogs)", lambda: (lambda bad: (not bad, bad))(b.js(f"{WALK_JS}('edit')")))
    check("brand, footer text, nav labels, hero buttons and contact labels are editable", lambda: b.js(
        "['ui.brand', 'ui.footer', 'ui.backToTop', 'nav.0.label', 'nav.5.label', 'ui.viewProjects', 'ui.getInTouch', 'ui.contactEmail', 'ui.contactLinkedIn',"
        " 'ui.contactLocation', 'ui.viewProfile', 'ui.fileMissing'].every(p => document.querySelector(`[data-edit=\"${p}\"]`)?.isContentEditable)"))
    check("'No image' placeholder is editable in edit mode", lambda: b.js(
        "[...document.querySelectorAll('[data-edit=\"ui.noImage\"]')].length > 0 && [...document.querySelectorAll('[data-edit=\"ui.noImage\"]')].every(e => e.isContentEditable)"))

    def edit_nav_label():
        b.js("(() => { const e = document.querySelector('[data-edit=\"nav.1.label\"]'); e.textContent = 'Key skills'; e.dispatchEvent(new Event('input', {bubbles: true})); })()")
        return b.js("import('/js/state.js').then(m => m.state.data.nav[1].label === 'Key skills')")
    check("editing a nav label updates the data", edit_nav_label)

    def links_inert():
        b.js("history.replaceState(null, '', location.pathname); document.querySelector('[data-nav] a[href=\"#contact\"]').click()")
        return b.js("location.hash === ''")
    check("links do not navigate while editing", links_inert)

    def add_remove(container, label, data_path):
        def run():
            before = b.js(f"import('/js/state.js').then(m => m.state.data.{data_path}.length)")
            b.js(f"[...document.querySelectorAll('.ed-add')].find(x => x.previousElementSibling?.matches('[data-collection=\"{container}\"]')).click()")
            b.wait(f"document.querySelectorAll('[data-collection=\"{container}\"] > [data-item]').length === {before + 1}")
            if not b.js(f"[...document.querySelectorAll('.ed-add')].some(x => x.textContent === '{label}')"):
                return (False, "add button label")
            # remove the new (last) item; whole entries ask for confirmation first
            b.js(f"[...document.querySelectorAll('[data-collection=\"{container}\"] > [data-item]')].pop().querySelector(':scope > .ed-btn--danger').click()")
            b.sleep(0.15)
            if b.js("!!document.querySelector('dialog[open]')"):
                b.js("document.querySelector('dialog[open] .dlg__actions .btn:not(.btn--ghost)').click()")
            b.wait(f"document.querySelectorAll('[data-collection=\"{container}\"] > [data-item]').length === {before}")
            return True
        return run
    check("experience entries can be added and removed", add_remove("experience", "Add job", "experience"))
    check("education entries can be added and removed", add_remove("education", "Add education", "education"))
    check("experience bullet points can be added and removed", add_remove("experience.0.bullets", "Add bullet point", "experience[0].bullets"))
    check("education bullet points can be added and removed", add_remove("education.0.bullets", "Add bullet point", "education[0].bullets"))
    check("skill groups can be added and removed", add_remove("skills", "Add skill group", "skills"))

    check("icon buttons get link editors; email uses an address field", lambda: b.js(
        "(() => { const s = [...document.querySelectorAll('.socials > a')]; return s.every(a => a.nextElementSibling?.classList.contains('ed-btn'))"
        " && s[1].nextElementSibling.textContent === 'Edit email' && s[0].nextElementSibling.textContent === 'Edit link'; })()"))

    def save():
        b.js("(() => { const e = document.querySelector('[data-edit=\"ui.brand\"]'); e.textContent = 'Tamara Pen PhD'; e.dispatchEvent(new Event('input', {bubbles: true})); })()")
        mock.calls.clear()
        b.js("[...document.querySelectorAll('.ownerbar button')].find(x => x.textContent === 'Save changes').click()")
        b.wait("document.querySelector('.ownerbar__status').textContent === 'Saved'")
        blobs = [json.loads(c["body"]) for c in mock.calls if c["url"].endswith("/git/blobs")]
        saved = json.loads(base64.b64decode(blobs[-1]["content"]).decode()) if blobs else {}
        patches = [c for c in mock.calls if c["method"] == "PATCH"]
        ok = (saved.get("ui", {}).get("brand") == "Tamara Pen PhD" and saved["nav"][1]["label"] == "Key skills"
              and len(patches) == 1 and all(c["auth"] == "Bearer good-token" for c in mock.calls))
        return (ok, [c["method"] + " " + c["url"] for c in mock.calls])
    check("Save commits data.json (with the edits) in one commit using the token", save)

    def logout():
        b.js("[...document.querySelectorAll('.ownerbar button')].find(x => x.textContent === 'Log out').click()")
        b.sleep(0.3)  # a confirmation appears only if there are unsaved changes
        b.js("document.querySelector('dialog[open] .dlg__actions .btn:not(.btn--ghost)')?.click()")
        b.wait("document.readyState === 'complete' && !document.querySelector('.ownerbar') && document.querySelector('#overview h1')", 10)
        return b.js("!sessionStorage.getItem('tp_owner_token') && document.getElementById('owner-login').dataset.tooltip === 'sign in to edit'")
    check("Log out clears the token and returns to the visitor view", logout)

    b.cmd("Fetch.disable")
    b.on_request = None


def main():
    srv, url = start_server()
    b = Browser()
    try:
        visitor_checks(b, url)
        owner_checks(b, url)
    except Exception:
        traceback.print_exc()
        RESULTS.append(("suite crashed", False, ""))
    finally:
        b.close()
        srv.shutdown()
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} checks passed")
    sys.exit(0 if passed == len(RESULTS) else 1)


if __name__ == "__main__":
    main()
