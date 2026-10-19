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
  tools/shoot.py --params "s=1700&speed=45" --shots 0 --settle 24 --hitches   (ride timing, capped at 60 fps)
  tools/shoot.py --params "speed=50" --shots 0 --settle 40 --hitches --fps 30  (budget ride at the 30 fps target)
  tools/shoot.py --params "s=1700&speed=45" --shots 0 --settle 24 --heapprof 40 (allocation sites)
  tools/shoot.py --params "s=1700&speed=45" --shots 0 --settle 150 --heaplive 40 (what the heap grows by)
  tools/shoot.py --shots 0 --cpuprof 40   (start-up: main-thread time by file and function, with callers)

Timing runs (--hitches, --heapprof) print the machine's load at the start and the end:
other processes may be rendering on the same CPU and GPU, so judge times against it.

Frame rate: Chrome runs here with vsync off, so an uncapped loop queues frames ahead of the
GPU and then blocks inside GL calls, which inflates CPU times and logs 'gpu-wait' hitches
that a display-synced browser never has. --fps N caps the app's requestAnimationFrame at N
from ready on, as vsync would; timing runs default to --fps 60 (--fps 0: uncapped). They
also sample every frame after ready and print its interval, CPU time (frame callback), GPU
time (gpuTimer.of(frame)), draw calls and triangles as percentiles ('frame samples').

The tool waits up to --timeout seconds for window.__ready (a cold start takes 15-25 s
on an idle machine and can take over a minute on a busy one), printing progress every
30 s. If the app is not ready by then it says so and takes no screenshots (exit code 1);
--force shoots the partly loaded page anyway.

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


# requestAnimationFrame capped at N a second (as vsync would), installed at ready: every
# caller's callbacks run together in the next slot, while real animation frames are polled
# until the slot comes (precise to about a millisecond). No allocation per frame.
FPS_CAP_JS = r"""(() => {
  if (window.__origRAF) return 'already';
  const CAP = %g, orig = window.__origRAF = window.requestAnimationFrame.bind(window), origCancel = window.cancelAnimationFrame.bind(window);
  let next = performance.now(), scheduled = false, id = 0;
  let qa = [], qi = [], qn = 0, ra = [], ri = [];
  const go = (ts) => {
    const now = performance.now();
    if (now < next - 0.7) { orig(go); return; }
    next = Math.max(next + 1000 / CAP, now - 1000 / CAP);
    scheduled = false;
    // (callbacks asked for while these run go to the next slot)
    const n = qn, a = qa, ids = qi;
    qa = ra; qi = ri; ra = a; ri = ids; qn = 0;
    for (let k = 0; k < n; k++) { const cb = a[k]; a[k] = null; if (cb) cb(ts); }
  };
  window.requestAnimationFrame = (cb) => {
    qa[qn] = cb; qi[qn] = ++id; qn++;
    if (!scheduled) { scheduled = true; orig(go); }
    return id;
  };
  window.cancelAnimationFrame = (h) => {
    for (let k = 0; k < qn; k++) if (qi[k] === h) { qa[k] = null; return; }
    origCancel(h);
  };
  return 'capped';
})()"""

# Per-frame samples after ready (typed arrays, no allocation per frame): frame interval,
# frame-callback CPU time, GPU time from gpuTimer.of(frame) (results arrive a few frames
# late), draw calls and triangles; summary() gives their percentiles.
SAMPLER_JS = r"""(() => {
  const a = window.__app;
  if (!a || !a.monitor || window.__shootSamp) return;
  const N = 1 << 16, LAG = 24;
  const iv = new Float32Array(N), cpu = new Float32Array(N), gpu = new Float32Array(N), calls = new Float32Array(N), tris = new Float32Array(N), fr = new Int32Array(N);
  const RAF = window.__origRAF || window.requestAnimationFrame.bind(window);
  let n = 0, lastF = a.frame, lastT = a.monitor.lastT;
  const S = window.__shootSamp = {
    reset() { n = 0; lastF = a.frame; lastT = a.monitor.lastT; },
    summary() {
      for (let i = Math.max(0, n - LAG); i < n; i++) { const g = a.gpuTimer.of(fr[i]); gpu[i] = g === null ? -1 : g; }
      const q = (arr, keep) => {
        const v = Array.from(arr.subarray(0, n)).filter(keep).sort((x, y) => x - y);
        if (!v.length) return null;
        const at = (f) => v[Math.min(v.length - 1, Math.floor(f * v.length))];
        return { n: v.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +v[v.length - 1].toFixed(2) };
      };
      const all = () => true, known = (x) => x >= 0;
      let g28 = 0, c20 = 0;
      for (let i = 0; i < n; i++) { if (gpu[i] > 28) g28++; if (cpu[i] > 20) c20++; }
      const fps = window.__origRAF ? 'capped' : 'uncapped';
      return JSON.stringify({ frames: n, loop: fps, intervalMs: q(iv, all), cpuMs: q(cpu, all), gpuMs: q(gpu, known), calls: q(calls, all), trianglesM: q(tris, all), gpuOver28: g28, cpuOver20: c20 });
    },
  };
  const tick = () => {
    if (a.frame !== lastF && n < N) {
      lastF = a.frame;
      const i = n++;
      const t = a.monitor.lastT;
      iv[i] = t - lastT; lastT = t;
      cpu[i] = a.monitor.cpu;
      calls[i] = a.renderer.info.render.calls; tris[i] = a.renderer.info.render.triangles / 1e6;
      fr[i] = a.frame;
      const j = i - LAG;
      if (j >= 0) { const g = a.gpuTimer.of(fr[j]); gpu[j] = g === null ? -1 : g; }
    }
    RAF(tick);
  };
  RAF(tick);
})()"""


def machine_load():
    """One line on how busy the machine is (other processes may share it): load average per
    core, headless Chrome processes running, GPU utilisation. Timing runs print it at the
    start and the end, so a slow run can be put down to contention before blaming a module."""
    parts = []
    try:
        l1, l5, _ = os.getloadavg()
        parts.append(f"load {l1:.1f}/{l5:.1f} on {os.cpu_count()} cores")
    except OSError:
        pass
    try:
        n = 0
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    cmd = f.read(4096)
            except OSError:
                continue
            if b"--headless" in cmd and b"--type=" not in cmd and (b"chrome" in cmd or b"chromium" in cmd):
                n += 1
        parts.append(f"{n} headless browsers")
    except OSError:
        pass
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=3).stdout.strip().splitlines()
            if out:
                parts.append(f"gpu {out[0].strip()}% busy")
        except Exception:
            pass
    return ", ".join(parts) or "unknown"


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


def print_cpu_profile(prof, top, label):
    """Main-thread CPU time by function (self time) and by source file, from a sampled
    profile (Profiler domain). Idle and GC show as (idle) / (garbage collector); time the
    page spent waiting inside GL calls is charged to the JS function that made the call."""
    nodes = {n["id"]: n for n in prof["nodes"]}
    dt = prof.get("timeDeltas", [])
    self_us = {}
    for sid, d in zip(prof.get("samples", []), dt[1:] + [0]):
        self_us[sid] = self_us.get(sid, 0) + d
    parent = {}
    for n in prof["nodes"]:
        for c in n.get("children", []):
            parent[c] = n["id"]

    def name(nid):
        cf = nodes[nid]["callFrame"]
        return f'{cf.get("functionName") or "(anon)"}@{os.path.basename(cf.get("url", "")).split("?")[0]}:{cf.get("lineNumber", -1) + 1}'

    by_fn, by_file, callers, total = {}, {}, {}, 0
    for nid, us in self_us.items():
        cf = nodes[nid]["callFrame"]
        fn = cf.get("functionName") or "(anon)"
        f = os.path.basename(cf.get("url", "")).split("?")[0]
        key = (fn, f, cf.get("lineNumber", -1) + 1)
        by_fn[key] = by_fn.get(key, 0) + us
        k2 = f or fn
        by_file[k2] = by_file.get(k2, 0) + us
        total += us
        # the nearest callers outside three.js (who asked for the work)
        chain, q = [], parent.get(nid)
        while q is not None and len(chain) < 2:
            if "three." not in (nodes[q]["callFrame"].get("url") or "") and nodes[q]["callFrame"].get("url"):
                chain.append(name(q))
            q = parent.get(q)
        c = callers.setdefault(key, {})
        ck = " <- ".join(chain)
        c[ck] = c.get(ck, 0) + us
    print(f"cpuprof ({label}): {total / 1e3:.0f} ms sampled")
    for k, us in sorted(by_file.items(), key=lambda kv: -kv[1])[:top]:
        print(f"  file {us / 1e3:8.0f} ms  {k}")
    for key, us in sorted(by_fn.items(), key=lambda kv: -kv[1])[:top]:
        fn, f, line = key
        cs = sorted(callers.get(key, {}).items(), key=lambda kv: -kv[1])[:2]
        via = "; ".join(f"{c or '-'} {v / 1e3:.0f}" for c, v in cs)
        print(f"  fn   {us / 1e3:8.0f} ms  {fn} {f}:{line}   [{via}]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", default="", help="query string for the app (without leading ?)")
    ap.add_argument("--page", default="index.html")
    ap.add_argument("--out", default=os.path.join(ROOT, ".work/shots/shot.png"))
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--port", type=int, default=int(os.environ.get("TRAM_PORT", "0")),
                    help="use an already running server on this port (default: start a private one)")
    ap.add_argument("--timeout", type=float, default=240, help="seconds to wait for window.__ready")
    ap.add_argument("--force", action="store_true", help="take the screenshots even if the app never became ready")
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
    ap.add_argument("--heaplive", type=int, default=0, metavar="N",
                    help="sample the JS allocations made from ready to the end that are still alive at the end "
                         "(what the heap grows by: caches, retained garbage, leaks) and print the top N sites. Typed-array "
                         "data is not sampled (only its small wrapper object), although performance.memory counts it: "
                         "compare heap snapshots for that")
    ap.add_argument("--snapshot", default=None, metavar="PATH",
                    help="after the shots, collect garbage and save a heap snapshot to PATH (open it in DevTools, "
                         "or diff two of them to see what a ride retains, typed-array data included)")
    ap.add_argument("--cpuprof", type=int, default=0, metavar="N",
                    help="sample the page's main thread from navigation to ready and print the top N source files "
                         "and functions by self time (start-up profile)")
    ap.add_argument("--fps", type=float, default=None, metavar="N",
                    help="cap the app's requestAnimationFrame at N frames a second from ready on, as vsync would "
                         "(default 60 for --hitches/--heapprof/--heaplive runs, else uncapped; 0: uncapped)")
    ap.add_argument("--keep-open", action="store_true")
    ap.add_argument("--profile", default=None, help="persistent Chrome profile dir (keeps the GPU shader cache between runs)")
    a = ap.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    timing = a.hitches or a.heapprof or a.heaplive
    if a.fps is None:
        a.fps = 60 if timing else 0
    if timing:
        print("machine at start:", machine_load())
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
        if a.cpuprof:
            ws.call("Profiler.enable", session=sess)
            ws.call("Profiler.setSamplingInterval", {"interval": 500}, session=sess)
            ws.call("Profiler.start", session=sess)
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
        ready = fatal = False
        next_note = 30
        while time.time() - t0 < a.timeout:
            v = js("window.__ready === true")
            if v is True:
                ready = True
                break
            err = js("window.__fatal || null")
            if err:
                print("FATAL:", err)
                fatal = True
                break
            if time.time() - t0 > next_note:
                next_note = time.time() - t0 + 30
                st = js("(() => { const a = window.__app; if (!a) return 'modules loading'; const p = a.perf && a.perf.init || {};"
                        " return 'init ' + JSON.stringify(p) + (a.world ? ' chunks ' + a.world.chunks.size : ''); })()")
                print(f"  still loading after {time.time() - t0:.0f}s: {st}", flush=True)
            time.sleep(0.25)
        print(f"ready={ready} after {time.time() - t0:.1f}s")
        if a.cpuprof:
            print_cpu_profile(ws.call("Profiler.stop", session=sess)["profile"], a.cpuprof, "navigation to ready")
        if not ready:
            rc = 1
            why = "a fatal error" if fatal else f"no window.__ready within --timeout {a.timeout:.0f}s"
            msg = (f"WARNING: the app is NOT ready ({why}): "
                   + ("taking the screenshots anyway (--force); they show a partly loaded scene" if a.force
                      else "no screenshots taken (pass --force to shoot anyway, or a longer --timeout)"))
            print(msg)
            print(msg, file=sys.stderr)
            if not a.force:
                a.shots = 0
        if ready and a.fps > 0:
            js(FPS_CAP_JS % a.fps)
            print(f"frame rate capped at {a.fps:g} fps (--fps)")
        if ready and timing:
            js(SAMPLER_JS)
        if a.pre:
            print("pre:", json.dumps(js(a.pre)))
        if a.hitches:
            js("window.__app && window.__app.resetFrames && window.__app.resetFrames()")
            js("window.__shootSamp && window.__shootSamp.reset()")
        heap_t0 = time.time()
        if a.heapprof or a.heaplive:
            # (one sampling session: with --heaplive, objects collected before the end are left out)
            ws.call("HeapProfiler.enable", session=sess)
            ws.call("HeapProfiler.startSampling", {"samplingInterval": 16384, "includeObjectsCollectedByMajorGC": not a.heaplive,
                                                   "includeObjectsCollectedByMinorGC": not a.heaplive}, session=sess)
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
        if ready and timing:
            fs = js("window.__shootSamp ? window.__shootSamp.summary() : null")
            if fs:
                print("frame samples:", fs)
        if a.hitches:
            rep = js("window.__app && window.__app.hitchReport ? window.__app.hitchReport() : null")
            print("hitches:", rep if isinstance(rep, str) else json.dumps(rep))
        if a.snapshot:
            ws.call("HeapProfiler.enable", session=sess)
            ws.call("HeapProfiler.collectGarbage", session=sess)
            os.makedirs(os.path.dirname(os.path.abspath(a.snapshot)), exist_ok=True)
            with open(a.snapshot, "w") as f:
                mid = ws.send("HeapProfiler.takeHeapSnapshot", {"reportProgress": False}, session=sess)
                while True:
                    m = ws.recv()
                    if m.get("method") == "HeapProfiler.addHeapSnapshotChunk":
                        f.write(m["params"]["chunk"])
                    elif m.get("id") == mid:
                        break
                    else:
                        ws.events.append(m)
            print("snapshot", a.snapshot, f"{os.path.getsize(a.snapshot) / 1048576:.0f} MB")
        if a.heapprof or a.heaplive:
            if a.heaplive:
                ws.call("HeapProfiler.collectGarbage", session=sess)
            prof = ws.call("HeapProfiler.stopSampling", session=sess)["profile"]
            if a.heaplive:
                print("heaplive: allocations since ready still alive at the end (after a full collection):")
            print_heap_profile(prof, a.heaplive or a.heapprof, time.time() - heap_t0)
        if timing:
            print("machine at end:", machine_load())
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
