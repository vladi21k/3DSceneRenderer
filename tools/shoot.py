#!/usr/bin/env python3
"""Headless Chrome (GPU) capture tool for visual checks of the app.

Pure standard library: launches Chrome with remote debugging, speaks the DevTools
protocol over a minimal WebSocket client, waits for the app to report ready,
then grabs PNG screenshots and console output.

Examples
  tools/shoot.py --out .work/shots/a.png
  tools/shoot.py --params "s=820&tod=0.55&fov=28" --out .work/shots/gold.png
  tools/shoot.py --params "s=300" --shots 3 --interval 1.0 --out .work/shots/seq.png
  tools/shoot.py --params "s=300" --eval "JSON.stringify(window.__app.stats())"
  tools/shoot.py --params "s=1700&speed=45" --shots 0 --settle 24 --hitches   (ride timing)

The page URL is http://127.0.0.1:<port>/index.html?<params>&capture=1 ; a private
static server (serve.py) is started on a free port unless --port is given.
"""
import argparse, base64, json, os, random, shutil, socket, struct, subprocess, sys, tempfile, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GPU_FLAGS = "--enable-gpu --ignore-gpu-blocklist --use-angle=gl"


def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class WS:
    def __init__(self, url):
        assert url.startswith("ws://")
        hostport, path = url[5:].split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=120)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        self.extra = buf.split(b"\r\n\r\n", 1)[1]
        self.next_id = 0
        self.events = []

    def _recv_exact(self, n):
        while len(self.extra) < n:
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise ConnectionError("websocket closed")
            self.extra += chunk
        out, self.extra = self.extra[:n], self.extra[n:]
        return out

    def recv(self):
        msg = b""
        while True:
            b1, b2 = self._recv_exact(2)
            fin, op = b1 & 0x80, b1 & 0x0F
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._recv_exact(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._recv_exact(8))[0]
            data = self._recv_exact(ln)
            if op == 8:
                raise ConnectionError("websocket closed by peer")
            if op in (0, 1, 2):
                msg += data
                if fin:
                    return json.loads(msg.decode("utf-8", "replace"))

    def send(self, method, params=None, session=None):
        self.next_id += 1
        payload = {"id": self.next_id, "method": method, "params": params or {}}
        if session:
            payload["sessionId"] = session
        data = json.dumps(payload).encode()
        hdr = bytearray([0x81])
        mask = os.urandom(4)
        if len(data) < 126:
            hdr.append(0x80 | len(data))
        elif len(data) < 65536:
            hdr.append(0x80 | 126); hdr += struct.pack(">H", len(data))
        else:
            hdr.append(0x80 | 127); hdr += struct.pack(">Q", len(data))
        hdr += mask
        self.sock.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        return self.next_id

    def call(self, method, params=None, session=None, timeout=120):
        mid = self.send(method, params, session)
        t0 = time.time()
        while time.time() - t0 < timeout:
            m = self.recv()
            if m.get("id") == mid:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})
            self.events.append(m)
        raise TimeoutError(method)


def print_heap_profile(prof, top, secs):
    """Allocation sites by sampled bytes (self), with their first caller."""
    sites, total = {}, 0

    def walk(node, parent):
        nonlocal total
        cf = node["callFrame"]
        size = node.get("selfSize", 0)
        total += size
        if size:
            key = (cf.get("functionName") or "(anon)", os.path.basename(cf.get("url", "")).split("?")[0], cf.get("lineNumber", -1) + 1)
            pcf = parent["callFrame"] if parent else {}
            caller = f'{pcf.get("functionName") or "(anon)"}@{os.path.basename(pcf.get("url", "")).split("?")[0]}:{pcf.get("lineNumber", -1) + 1}' if parent else ""
            e = sites.setdefault(key, [0, {}])
            e[0] += size
            e[1][caller] = e[1].get(caller, 0) + size
        for ch in node.get("children", []):
            walk(ch, node)

    walk(prof["head"], None)
    print(f"heapprof: {total / 1048576:.1f} MB sampled in {secs:.1f} s ({total / 1048576 / max(secs, 1e-3):.2f} MB/s)")
    for (fn, url, line), (size, callers) in sorted(sites.items(), key=lambda kv: -kv[1][0])[:top]:
        c = max(callers.items(), key=lambda kv: kv[1])[0] if callers else ""
        print(f"  {size / 1048576:7.2f} MB  {fn} {url}:{line}  <- {c}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", default="", help="query string for the app (without leading ?)")
    ap.add_argument("--page", default="index.html")
    ap.add_argument("--out", default=os.path.join(ROOT, ".work/shots/shot.png"))
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--port", type=int, default=int(os.environ.get("TRAM_PORT", "0")),
                    help="use an already running server on this port (default: start a private one)")
    ap.add_argument("--timeout", type=float, default=90, help="seconds to wait for window.__ready")
    ap.add_argument("--settle", type=float, default=1.5, help="extra seconds after ready before first shot")
    ap.add_argument("--shots", type=int, default=1)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--eval", default=None, help="JS expression evaluated after the shots; result printed")
    ap.add_argument("--pre", default=None, help="JS evaluated right after ready (before settle)")
    ap.add_argument("--console", action="store_true", help="print all console messages, not only errors/warnings")
    ap.add_argument("--hitches", action="store_true",
                    help="reset the frame statistics after ready and print the frame-time summary and hitch log "
                         "(frame intervals over 50 ms) at the end; screenshots stall frames, so time rides with --shots 0")
    ap.add_argument("--heapprof", type=int, default=0, metavar="N",
                    help="sample JS allocations (garbage included) from ready to the end and print the top N "
                         "allocation sites by bytes")
    ap.add_argument("--keep-open", action="store_true")
    ap.add_argument("--profile", default=None, help="persistent Chrome profile dir (keeps the GPU shader cache between runs)")
    a = ap.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    server = None
    if not a.port:
        a.port = free_port()
        server = subprocess.Popen([sys.executable, os.path.join(ROOT, "serve.py"), str(a.port), "127.0.0.1"],
                                  cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            if port_open(a.port):
                break
            time.sleep(0.1)

    dbg = free_port()
    profile = os.path.abspath(a.profile) if a.profile else tempfile.mkdtemp(prefix="shoot-", dir=os.path.join(ROOT, ".work"))
    if a.profile:
        os.makedirs(profile, exist_ok=True)
    chrome = shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
    args = [chrome, "--headless=new", f"--remote-debugging-port={dbg}", f"--user-data-dir={profile}",
            f"--window-size={a.width},{a.height}", "--hide-scrollbars", "--mute-audio",
            "--no-first-run", "--no-default-browser-check", "--disable-extensions",
            "--enable-precise-memory-info",
            *os.environ.get("SHOOT_GPU_FLAGS", GPU_FLAGS).split(),
            "--disable-gpu-vsync", "--disable-frame-rate-limit",
            "--autoplay-policy=no-user-gesture-required", "about:blank"]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rc = 0
    try:
        ws_url = None
        for _ in range(100):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{dbg}/json/version", timeout=1) as r:
                    ws_url = json.load(r)["webSocketDebuggerUrl"]
                break
            except Exception:
                time.sleep(0.1)
        if not ws_url:
            print("ERROR: chrome did not start", file=sys.stderr)
            return 2
        ws = WS(ws_url)
        tgt = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        sess = ws.call("Target.attachToTarget", {"targetId": tgt, "flatten": True})["sessionId"]
        ws.call("Runtime.enable", session=sess)
        ws.call("Page.enable", session=sess)
        ws.call("Emulation.setDeviceMetricsOverride",
                {"width": a.width, "height": a.height, "deviceScaleFactor": 1, "mobile": False}, session=sess)
        sep = "&" if a.params else ""
        url = f"http://127.0.0.1:{a.port}/{a.page}?{a.params}{sep}capture=1&cb={random.randint(0, 1 << 30)}"
        ws.call("Page.navigate", {"url": url}, session=sess)

        logs = []

        def drain_events():
            for m in ws.events:
                if m.get("method") == "Runtime.consoleAPICalled":
                    p = m["params"]
                    txt = " ".join(str(x.get("value", x.get("description", ""))) for x in p.get("args", []))
                    logs.append((p.get("type"), txt))
                elif m.get("method") == "Runtime.exceptionThrown":
                    d = m["params"]["exceptionDetails"]
                    ex = d.get("exception", {}).get("description") or d.get("text")
                    logs.append(("exception", f"{ex} @ {d.get('url', '')}:{d.get('lineNumber')}"))
            ws.events.clear()

        def js(expr, await_promise=True):
            r = ws.call("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                             "awaitPromise": await_promise}, session=sess)
            drain_events()
            if "exceptionDetails" in r:
                return {"__error__": r["exceptionDetails"].get("exception", {}).get("description", str(r))}
            return r.get("result", {}).get("value")

        t0 = time.time()
        ready = False
        while time.time() - t0 < a.timeout:
            v = js("window.__ready === true")
            if v is True:
                ready = True
                break
            err = js("window.__fatal || null")
            if err:
                print("FATAL:", err)
                break
            time.sleep(0.25)
        print(f"ready={ready} after {time.time() - t0:.1f}s")
        if not ready:
            rc = 1
        if a.pre:
            print("pre:", json.dumps(js(a.pre)))
        if a.hitches:
            js("window.__app && window.__app.resetFrames && window.__app.resetFrames()")
        heap_t0 = time.time()
        if a.heapprof:
            ws.call("HeapProfiler.enable", session=sess)
            ws.call("HeapProfiler.startSampling", {"samplingInterval": 16384, "includeObjectsCollectedByMajorGC": True,
                                                   "includeObjectsCollectedByMinorGC": True}, session=sess)
        time.sleep(a.settle)
        base, ext = os.path.splitext(a.out)
        for i in range(a.shots):
            if i:
                time.sleep(a.interval)
            shot = ws.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False}, session=sess)
            path = a.out if a.shots == 1 else f"{base}_{i:02d}{ext}"
            with open(path, "wb") as f:
                f.write(base64.b64decode(shot["data"]))
            print("saved", path)
        stats = js("window.__app && window.__app.stats ? JSON.stringify(window.__app.stats()) : null")
        if stats:
            print("stats:", stats)
        if a.eval:
            print("eval:", json.dumps(js(a.eval)))
        if a.hitches:
            rep = js("window.__app && window.__app.hitchReport ? window.__app.hitchReport() : null")
            print("hitches:", rep if isinstance(rep, str) else json.dumps(rep))
        if a.heapprof:
            prof = ws.call("HeapProfiler.stopSampling", session=sess)["profile"]
            print_heap_profile(prof, a.heapprof, time.time() - heap_t0)
        drain_events()
        for typ, txt in logs:
            if a.console or typ in ("error", "warning", "exception", "assert"):
                print(f"[{typ}] {txt[:2000]}")
        if any(t in ("error", "exception") for t, _ in logs):
            rc = rc or 3
        if a.keep_open:
            input("press enter to close")
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except Exception:
            proc.kill()
        if not a.profile:
            shutil.rmtree(profile, ignore_errors=True)
        if server:
            server.terminate()
    return rc


if __name__ == "__main__":
    sys.exit(main())
