#!/usr/bin/env python3
"""Headless Chrome (on the real GPU) capture tool for a browser 3D app. Standard library only.

It serves --root on a private port, opens the page with `capture=1` added to --params,
waits until the page sets `window.__ready = true`, then saves screenshots (.png or .jpg by
the --out extension), prints the app's stats line, console errors and any --eval result.
Chrome is always killed at the end, however the tool ends (see "Browser lifetime").

Examples
  shoot.py --root ~/proj --params "s=420&tod=0.55" --out shots/gold.jpg
  shoot.py --params "s=300&speed=40" --shots 4 --interval 0.5 --out shots/seq.png   (seq_00.png ...)
  shoot.py --params "speed=0" --shots 0 --eval "JSON.stringify(window.__app.stats())"
  shoot.py --params "speed=45" --shots 0 --fps 30 --pre "window.__FT={seconds:30}" --eval-file frametimes.js
  shoot.py --params "speed=45" --shots 0 --fps 60 --pre-file frametimes.js --settle 30 --eval-file frametimes.js
  shoot.py --shots 0 --cpuprof 30                       (start-up: main-thread time by file and function)
  shoot.py --params "speed=45" --shots 0 --settle 30 --heapprof 30 --heapdelay 20 (warm allocation sites)
  shoot.py --profile .work/prof --params "speed=60" --shots 0 --settle 30 --firstdraw   (three.js only)
  shoot.py --wait-quiet 900 --fps 30 ...                (timing: wait for an idle machine first)
  shoot.py --reap                                       (kill headless browsers left by dead runs)

App-side contract (all optional except window.__ready):
  window.__ready = true     everything visible is loaded and drawn (set it a few frames late)
  window.__fatal = "msg"    start-up failed: stop waiting, exit 1
  window.__progress         anything JSON-able, printed every 30 s while loading
  window.__app.stats()      perf counters, printed as the `stats:` line after the shots
  capture=1 URL parameter   no UI, no click-to-start gate, no audio, loading veil removed at ready
  #loading element          a loading veil; the tool waits for it to be gone before a shot
                            (--veil to change the selector)

GPU: Chrome runs --headless=new with --enable-gpu --ignore-gpu-blocklist --use-angle=gl
(proven on Linux + NVIDIA; SHOOT_GPU_FLAGS replaces them). The tool prints the WebGL renderer
string first; if it names SwiftShader / llvmpipe / software, every timing and most images
are meaningless (--require-gpu turns that into exit 4).

Frame rate: vsync is off headless, so an uncapped loop queues frames ahead of the GPU and
then blocks inside GL calls: CPU times inflate and fake 50-110 ms 'gpu-wait' hitches appear.
--fps N caps requestAnimationFrame at N from ready on, as a display would. Use it for every
timing run, run one capture at a time, and screenshot-free (--shots 0): a screenshot stalls
the frame it is taken in.

Browser lifetime: Chrome runs in a process group of its own, killed on normal exit, on an
exception, on SIGTERM/SIGINT/SIGHUP (as `timeout` sends) and, through a tiny watchdog process
holding a pipe to the tool, even when the tool is SIGKILLed. An orphaned headless Chrome
renders uncapped forever (once it held a GPU at 97% for 78 minutes and skewed every timing
taken meanwhile). Every run first reaps browsers tagged by a tool that is gone.

Exit codes: 0 ok, 1 never ready / fatal, 2 Chrome did not start, 3 console errors or
exceptions, 4 software renderer with --require-gpu, 124 --max-seconds passed, 130 Ctrl+C.
"""
import argparse, atexit, base64, http.server, json, os, random, shutil, signal, socket, socketserver
import struct, subprocess, sys, tempfile, threading, time

GPU_FLAGS = "--enable-gpu --ignore-gpu-blocklist --use-angle=gl"
# Chrome ignores switches it does not know: this tags a browser with the pid of its tool, so a
# browser whose tool is gone can be recognised as an orphan and killed by the next run.
OWNER_FLAG = "--shoot-owner="
SOFTWARE_GL = ("swiftshader", "llvmpipe", "software", "softpipe", "lavapipe")


# ---------------------------------------------------------------- private static server
# (same rules as serve.py: deep backlog, JS MIME, no-cache; in-process, so it dies with the tool)

class _Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
                      ".glb": "model/gltf-binary", ".ktx2": "image/ktx2", ".json": "application/json"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *a):
        pass

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass


class _Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 512   # default 5: a burst of ~200 module imports overflows it


def start_server(root):
    """Serve root on a free 127.0.0.1 port from a daemon thread; returns the port."""
    srv = _Server(("127.0.0.1", 0), lambda *a, **kw: _Handler(*a, directory=root, **kw))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


# ---------------------------------------------------------------- process lifetime

_WATCHDOG = r"""
import os, select, signal, sys, time
for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(s, signal.SIG_IGN)
parent, deadline, label = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
groups, buf = set(), b""
def alive(g):
    try:
        os.killpg(g, 0); return True
    except (ProcessLookupError, PermissionError):
        return False
def kill_groups():
    for sig, grace in ((signal.SIGTERM, 3.0), (signal.SIGKILL, 2.0)):
        for g in list(groups):
            try: os.killpg(g, sig)
            except (ProcessLookupError, PermissionError): groups.discard(g)
        end = time.time() + grace
        while groups and time.time() < end:
            for g in list(groups):
                if not alive(g): groups.discard(g)
            time.sleep(0.05)
        if not groups: return
while True:
    wait = None if deadline <= 0 else max(0.0, deadline - time.time())
    r, _, _ = select.select([0], [], [], wait)
    if not r:
        if groups: sys.stderr.write(f"{label} watchdog: deadline passed; killing its browser\n")
        kill_groups()
        try:
            os.kill(parent, signal.SIGTERM); time.sleep(10); os.kill(parent, signal.SIGKILL)
        except ProcessLookupError:
            pass
        break
    chunk = os.read(0, 4096)
    if not chunk:
        kill_groups(); break
    buf += chunk
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        op, _, g = line.partition(b" ")
        if op == b"+": groups.add(int(g))
        elif op == b"-": groups.discard(int(g))
"""


class Overrun(SystemExit):
    """Raised in the tool when --max-seconds passes."""


class ProcessGuard:
    """Starts children in their own process groups and guarantees every group is gone when the
    tool ends, however it ends. guard = ProcessGuard(label, max_s); p = guard.spawn([...]);
    guard.stop(p); guard.close() (also runs at exit and on signals)."""

    def __init__(self, label, max_seconds=0.0):
        self.label, self.children, self.closed = label, [], False
        self._wd, self._pipe = None, None
        self.max_seconds = max_seconds or 0.0
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, self._on_signal)
        if self.max_seconds > 0:
            signal.signal(signal.SIGALRM, self._on_alarm)
            signal.alarm(max(1, int(round(self.max_seconds))))
        atexit.register(self.close)
        try:
            r, w = os.pipe()
            deadline = time.time() + self.max_seconds + 30 if self.max_seconds > 0 else 0   # backstop
            self._wd = subprocess.Popen([sys.executable, "-c", _WATCHDOG, str(os.getpid()), repr(deadline), label],
                                        stdin=r, stdout=subprocess.DEVNULL, start_new_session=True)
            os.close(r)
            self._pipe = w
        except OSError as e:
            print(f"WARNING: {label}: no watchdog ({e}); browsers are still killed at exit", file=sys.stderr)

    def _tell(self, msg):
        if self._pipe is not None:
            try:
                os.write(self._pipe, msg.encode())
            except OSError:
                pass

    def _on_signal(self, sig, frame):
        print(f"{self.label}: {signal.Signals(sig).name} received, closing the browser", file=sys.stderr, flush=True)
        if sig == signal.SIGINT:
            raise KeyboardInterrupt
        raise SystemExit(128 + sig)

    def _on_alarm(self, sig, frame):
        print(f"{self.label}: --max-seconds {self.max_seconds:g} passed, closing the browser", file=sys.stderr, flush=True)
        raise Overrun(124)

    def spawn(self, args, **kw):
        p = subprocess.Popen(args, start_new_session=True, **kw)
        self.children.append(p)
        self._tell(f"+ {p.pid}\n")
        return p

    @staticmethod
    def _group_alive(g):
        try:
            os.killpg(g, 0)
            return True
        except (ProcessLookupError, PermissionError):
            return False

    def stop(self, p, grace=5.0):
        """SIGTERM to the child first (Chrome shuts down cleanly and flushes its caches), then
        SIGTERM and SIGKILL to its whole group (zygotes, GPU process, renderers)."""
        g = p.pid
        for sig, wait in ((None, grace), (signal.SIGTERM, 2.0), (signal.SIGKILL, 2.0)):
            try:
                p.terminate() if sig is None else os.killpg(g, sig)
            except (ProcessLookupError, PermissionError):
                pass
            end = time.time() + wait
            while time.time() < end:
                p.poll()   # (reap the child so its zombie does not keep the group alive)
                if p.returncode is not None and not self._group_alive(g):
                    break
                time.sleep(0.05)
            else:
                continue
            break
        try:
            p.wait(1)
        except Exception:
            pass
        if self._group_alive(g):
            print(f"WARNING: {self.label}: process group {g} survived SIGKILL", file=sys.stderr)
        else:
            self._tell(f"- {g}\n")
        if p in self.children:
            self.children.remove(p)

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            signal.alarm(0)
        except Exception:
            pass
        old = {}
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):   # no second signal cuts cleanup short
            try:
                old[sig] = signal.signal(sig, signal.SIG_IGN)
            except Exception:
                pass
        try:
            for p in reversed(list(self.children)):
                self.stop(p)
        finally:
            if self._pipe is not None:
                try:
                    os.close(self._pipe)
                except OSError:
                    pass
                self._pipe = None
            if self._wd is not None:
                try:
                    self._wd.wait(5)
                except Exception:
                    pass
            for sig, h in old.items():
                if h in (None, self._on_signal):
                    h = signal.default_int_handler if sig == signal.SIGINT else signal.SIG_DFL
                try:
                    signal.signal(sig, h)
                except Exception:
                    pass


def _cmdline(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().split(b"\0")
    except OSError:
        return None


def headless_browsers(exclude_owner=None):
    """pids of top-level headless Chrome/Chromium processes of this user (renderer, GPU and
    utility children carry --type= and are skipped; so are other programs with a --headless flag)."""
    out, me = [], os.getuid()
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        c = _cmdline(int(d))
        if not c or not c[0] or not any(x.startswith(b"--headless") for x in c) or any(x.startswith(b"--type=") for x in c):
            continue
        exe = os.path.basename(c[0]).lower()
        if b"chrom" not in exe:
            continue
        try:
            if os.stat(f"/proc/{d}").st_uid != me:
                continue
        except OSError:
            continue
        if exclude_owner and (OWNER_FLAG + str(exclude_owner)).encode() in c:
            continue
        out.append((int(d), c))
    return out


def reap_orphans(work=None, verbose=True):
    """Kill headless browsers tagged --shoot-owner=<pid> whose tool is no longer a running
    Python script, and delete stale scratch profiles (shoot-*, record-*) under `work`."""
    reaped = []
    for pid, c in headless_browsers():
        owner = next((x[len(OWNER_FLAG):] for x in c if x.startswith(OWNER_FLAG.encode())), None)
        if owner is None:
            continue   # (not ours: never touch a browser we did not start)
        oc = _cmdline(int(owner)) if owner.isdigit() else None
        if oc and any(x.endswith(b".py") for x in oc):
            continue
        try:
            if os.getpgid(pid) == pid:
                os.killpg(pid, signal.SIGKILL)
            else:
                os.kill(pid, signal.SIGKILL)
            reaped.append(pid)
        except (ProcessLookupError, PermissionError):
            pass
    if work:
        _clean_profiles(work)
    if reaped and verbose:
        print(f"reaped {len(reaped)} orphaned headless browser(s) left by an earlier run: {reaped}", flush=True)
    return reaped


def _clean_profiles(work, min_age=900):
    try:
        names = [n for n in os.listdir(work) if n.startswith(("shoot-", "record-"))]
    except OSError:
        return
    if not names:
        return
    used = set()
    for d in os.listdir("/proc"):
        if d.isdigit():
            for x in _cmdline(int(d)) or ():
                if x.startswith(b"--user-data-dir="):
                    used.add(os.path.basename(x[16:].rstrip(b"/")).decode("utf-8", "replace"))
    now = time.time()
    for n in names:
        p = os.path.join(work, n)
        try:
            if n in used or not os.path.isdir(p) or now - os.stat(p).st_mtime < min_age:
                continue
        except OSError:
            continue
        shutil.rmtree(p, ignore_errors=True)


def machine_load():
    """One line: load average, other headless browsers, GPU utilisation. Print it next to every
    timing: other processes sharing the CPU/GPU are the usual cause of a 'regression'."""
    parts = []
    try:
        l1, l5, _ = os.getloadavg()
        parts.append(f"load {l1:.1f}/{l5:.1f} on {os.cpu_count()} cores")
    except OSError:
        pass
    parts.append(f"{len(headless_browsers(exclude_owner=os.getpid()))} other headless browsers")
    g = gpu_util()
    if g is not None:
        parts.append(f"gpu {g}% busy")
    return ", ".join(parts)


def gpu_util():
    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout.split()
        return int(out[0]) if out else None
    except Exception:
        return None


def wait_quiet(max_wait, max_load=None, max_gpu=30, need=4):
    """Wait (up to max_wait s) until the machine has been idle for `need` consecutive checks:
    no other headless browser, load1 under max_load, GPU under max_gpu %. True if it got quiet."""
    max_load = max_load if max_load is not None else max(2.0, 0.2 * (os.cpu_count() or 4))
    t0, ok = time.time(), 0
    while time.time() - t0 < max_wait:
        l1 = os.getloadavg()[0]
        g = gpu_util()
        busy = headless_browsers(exclude_owner=os.getpid())
        ok = ok + 1 if (not busy and l1 < max_load and (g is None or g < max_gpu)) else 0
        if ok >= need:
            print(f"machine quiet after {time.time() - t0:.0f}s", flush=True)
            return True
        time.sleep(1)
    print(f"WARNING: machine still busy after {max_wait:g}s ({machine_load()}); timings below are suspect", flush=True)
    return False


def chrome_args(profile, width, height, extra=()):
    chrome = (os.environ.get("SHOOT_CHROME") or shutil.which("google-chrome") or shutil.which("google-chrome-stable")
              or shutil.which("chromium") or shutil.which("chromium-browser") or "google-chrome")
    return [chrome, "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={profile}",
            f"--window-size={width},{height}", "--hide-scrollbars", "--mute-audio",
            "--no-first-run", "--no-default-browser-check", "--disable-extensions",
            *extra,
            *os.environ.get("SHOOT_GPU_FLAGS", GPU_FLAGS).split(), *os.environ.get("SHOOT_CHROME_FLAGS", "").split(),
            "--disable-gpu-vsync", "--disable-frame-rate-limit",
            f"{OWNER_FLAG}{os.getpid()}", "about:blank"]


def devtools_ws(profile, proc, timeout=30.0):
    """Chrome picks a free DevTools port itself (port 0) and writes it to
    <profile>/DevToolsActivePort, so parallel runs can never drive each other's browser."""
    path = os.path.join(profile, "DevToolsActivePort")
    end = time.time() + timeout
    while time.time() < end:
        if proc.poll() is not None:
            return None
        try:
            with open(path) as f:
                lines = f.read().split()
            if len(lines) >= 2 and lines[0].isdigit():
                return f"ws://127.0.0.1:{lines[0]}{lines[1]}"
        except OSError:
            pass
        time.sleep(0.05)
    return None


def chrome_stderr():
    path = os.environ.get("SHOOT_STDERR")   # keep Chrome's own output (GPU init errors etc.)
    return open(path, "w") if path else subprocess.DEVNULL


class WS:
    """Minimal DevTools-protocol client over a hand-rolled WebSocket (no dependencies)."""

    def __init__(self, url):
        hostport, path = url[5:].split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=120)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        self.extra = buf.split(b"\r\n\r\n", 1)[1]
        self.next_id, self.events = 0, []

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
            fin, op, ln = b1 & 0x80, b1 & 0x0F, b2 & 0x7F
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
        hdr, mask = bytearray([0x81]), os.urandom(4)
        if len(data) < 126:
            hdr.append(0x80 | len(data))
        elif len(data) < 65536:
            hdr.append(0x80 | 126); hdr += struct.pack(">H", len(data))
        else:
            hdr.append(0x80 | 127); hdr += struct.pack(">Q", len(data))
        self.sock.sendall(bytes(hdr) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        return self.next_id

    def call(self, method, params=None, session=None, timeout=120):
        mid = self.send(method, params, session)
        self.sock.settimeout(timeout + 5)
        t0 = time.time()
        try:
            while time.time() - t0 < timeout:
                m = self.recv()
                if m.get("id") == mid:
                    if "error" in m:
                        raise RuntimeError(f"{method}: {m['error']}")
                    return m.get("result", {})
                self.events.append(m)
        finally:
            self.sock.settimeout(120)
        raise TimeoutError(method)


def open_page(ws, width, height):
    """New tab + flat session, Runtime/Page enabled, exact viewport. Returns the session id."""
    tgt = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
    sess = ws.call("Target.attachToTarget", {"targetId": tgt, "flatten": True})["sessionId"]
    ws.call("Runtime.enable", session=sess)
    ws.call("Page.enable", session=sess)
    ws.call("Emulation.setDeviceMetricsOverride",
            {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False}, session=sess)
    return sess


GPU_INFO_JS = r"""(() => { try { const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return 'NO WEBGL2';
  const e = gl.getExtension('WEBGL_debug_renderer_info');
  const r = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  gl.getExtension('WEBGL_lose_context')?.loseContext(); return String(r); } catch (e) { return 'ERROR ' + e; } })()"""


def gpu_check(js):
    """Print the WebGL renderer string (on about:blank, before the app). False if software."""
    r = js(GPU_INFO_JS) or "?"
    soft = any(k in str(r).lower() for k in SOFTWARE_GL) or str(r).startswith(("NO WEBGL", "ERROR"))
    print(f"gpu: {r}" + ("   <-- SOFTWARE RENDERER: images and timings are not representative" if soft else ""), flush=True)
    return not soft


# requestAnimationFrame capped at N/s from ready on, as vsync would (no allocation per frame).
FPS_CAP_JS = r"""(() => {
  if (window.__origRAF) return 'already';
  const CAP = %g, orig = window.__origRAF = window.requestAnimationFrame.bind(window), origCancel = window.cancelAnimationFrame.bind(window);
  let next = performance.now(), scheduled = false, id = 0, qa = [], qi = [], qn = 0, ra = [], ri = [];
  const go = (ts) => {
    const now = performance.now();
    if (now < next - 0.7) { orig(go); return; }
    next = Math.max(next + 1000 / CAP, now - 1000 / CAP);
    scheduled = false;
    const n = qn, a = qa, ids = qi; qa = ra; qi = ri; ra = a; ri = ids; qn = 0;   // (callbacks asked for meanwhile go to the next slot)
    for (let k = 0; k < n; k++) { const cb = a[k]; a[k] = null; if (cb) cb(ts); }
  };
  window.requestAnimationFrame = (cb) => { qa[qn] = cb; qi[qn] = ++id; qn++; if (!scheduled) { scheduled = true; orig(go); } return id; };
  window.cancelAnimationFrame = (h) => { for (let k = 0; k < qn; k++) if (qi[k] === h) { qa[k] = null; return; } origCancel(h); };
  return 'capped';
})()"""

VEIL_SHOWN_JS = r"""(() => { const e = document.querySelector(%s); if (!e || !e.isConnected) return false;
  const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0; })()"""


def veil_gone(js, selector, label, wait=10.0):
    """Wait until the loading veil is gone before a frame is grabbed (a CSS fade only advances on
    browser frames, which Chrome can hold back for seconds after a cold start). A veil still
    showing after `wait` s is reported and hidden, so no saved frame shows it."""
    if not selector:
        return True
    q = json.dumps(selector)
    t0 = time.time()
    while js(VEIL_SHOWN_JS % q) is True:
        if time.time() - t0 > wait:
            print(f"WARNING: {label}: loading veil {selector} still showed {wait:g}s after ready; hidden for the frames", flush=True)
            js(f"(() => {{ const e = document.querySelector({q}); if (e) e.style.display = 'none'; return true; }})()")
            return False
        time.sleep(0.1)
    return True


# --firstdraw (three.js): note each WebGL program's first non-empty draw; programs first drawn
# after ready each stall a riding frame by 100-250 ms (shader link + first-use upload).
FIRSTDRAW_HOOK_JS = r"""(() => {
  if (window.__firstUse || typeof WebGL2RenderingContext === 'undefined') return;
  const P = WebGL2RenderingContext.prototype, seen = new Map(), cur = new WeakMap(), made = new Map();
  window.__firstUse = seen; window.__made = made;
  const state = () => { const a = window.__app; return { frame: a ? a.frame : -1, where: a && a.where ? a.where() : null, ready: window.__ready === true || !!(a && a.ready) }; };
  const cp = P.createProgram; P.createProgram = function () { const p = cp.call(this); made.set(p, state()); return p; };
  const use = P.useProgram; P.useProgram = function (p) { cur.set(this, p); return use.call(this, p); };
  const mark = (gl) => { const p = cur.get(gl); if (p && !seen.has(p)) seen.set(p, state()); };
  const cnt = { drawElements: (a) => a[1], drawArrays: (a) => a[2], drawElementsInstanced: (a) => a[1] * a[4], drawArraysInstanced: (a) => a[2] * a[3], drawRangeElements: (a) => a[3] };
  for (const n of Object.keys(cnt)) { const f = P[n]; if (!f) continue; P[n] = function (...a) { if (cnt[n](a) > 0) mark(this); return f.apply(this, a); }; }
  const ge = P.getExtension;
  P.getExtension = function (name) {
    const ext = ge.call(this, name);
    if (ext && /multi_draw/i.test(name) && !ext.__probe) { const gl = this; ext.__probe = true;
      for (const n of Object.getOwnPropertyNames(Object.getPrototypeOf(ext))) { if (!/^multiDraw/.test(n)) continue; const f = ext[n];
        ext[n] = function (...a) { if (a[a.length - 1] > 0) mark(gl); return f.apply(ext, a); }; } }
    return ext;
  };
})();"""

FIRSTDRAW_REPORT_JS = r"""(() => {
  const app = window.__app, r = app && app.renderer, seen = window.__firstUse, made = window.__made;
  if (!r || !seen) return null;
  const byGl = new Map();
  for (const p of r.info.programs || []) byGl.set(p.program, { id: p.id, name: p.name, mats: [] });
  if (app.scene) app.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material.slice() : o.material ? [o.material] : [];
    for (const m of ms) { const pr = r.properties.get(m).currentProgram; const e = pr && byGl.get(pr.program); if (!e) continue;
      const nm = (o.name || o.type) + '/' + (m.name || m.type); if (!e.mats.includes(nm) && e.mats.length < 4) e.mats.push(nm); }
  });
  const late = [], never = [];
  for (const [gp, e] of byGl) { const u = seen.get(gp), c = made && made.get(gp);
    const born = c ? (c.ready ? 'created after ready, frame ' + c.frame : 'start-up') : '?';
    if (!u) never.push(e.id + ' ' + e.name + ' [' + e.mats.join(', ') + ']');
    else if (u.ready) late.push({ id: e.id, name: e.name, frame: u.frame, where: u.where, born, mats: e.mats }); }
  late.sort((x, y) => x.frame - y.frame);
  return { frame: app.frame, programs: byGl.size, late, never };
})()"""


def print_heap_profile(prof, top, secs):
    sites, total = {}, 0

    def walk(node, parent):
        nonlocal total
        cf, size = node["callFrame"], node.get("selfSize", 0)
        total += size
        if size:
            key = (cf.get("functionName") or "(anon)", os.path.basename(cf.get("url", "")).split("?")[0], cf.get("lineNumber", -1) + 1)
            pcf = parent["callFrame"] if parent else {}
            caller = (f'{pcf.get("functionName") or "(anon)"}@{os.path.basename(pcf.get("url", "")).split("?")[0]}:'
                      f'{pcf.get("lineNumber", -1) + 1}') if parent else ""
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
    nodes = {n["id"]: n for n in prof["nodes"]}
    dt = prof.get("timeDeltas", [])
    self_us = {}
    for sid, d in zip(prof.get("samples", []), dt[1:] + [0]):
        self_us[sid] = self_us.get(sid, 0) + d
    by_fn, by_file, total = {}, {}, 0
    for nid, us in self_us.items():
        cf = nodes[nid]["callFrame"]
        fn, f = cf.get("functionName") or "(anon)", os.path.basename(cf.get("url", "")).split("?")[0]
        key = (fn, f, cf.get("lineNumber", -1) + 1)
        by_fn[key] = by_fn.get(key, 0) + us
        by_file[f or fn] = by_file.get(f or fn, 0) + us
        total += us
    print(f"cpuprof ({label}): {total / 1e3:.0f} ms sampled  (idle and GC show as (idle) / (garbage collector);"
          f" time blocked inside GL calls is charged to the JS caller)")
    for k, us in sorted(by_file.items(), key=lambda kv: -kv[1])[:top]:
        print(f"  file {us / 1e3:8.0f} ms  {k}")
    for (fn, f, line), us in sorted(by_fn.items(), key=lambda kv: -kv[1])[:top]:
        print(f"  fn   {us / 1e3:8.0f} ms  {fn} {f}:{line}")


def show(v):
    """An evaluation result for printing: strings (e.g. JSON.stringify output) as they are."""
    return v if isinstance(v, str) else json.dumps(v)


def read_js(inline, path):
    if path:
        with open(path) as f:
            return f.read()
    return inline


def build_url(a, port):
    extra = "&".join(x for x in (a.params, a.capture_param, f"cb={random.randint(0, 1 << 30)}") if x)
    if a.url:
        return a.url + ("&" if "?" in a.url else "?") + extra
    return f"http://127.0.0.1:{port}/{a.page.lstrip('/')}?{extra}"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=os.getcwd(), help="directory to serve (default: current directory)")
    ap.add_argument("--page", default="index.html")
    ap.add_argument("--params", default="", help="URL query for the app, without '?'")
    ap.add_argument("--capture-param", default="capture=1", help="added to every URL ('' for none)")
    ap.add_argument("--url", default=None, help="open this URL instead of serving --root (params still appended)")
    ap.add_argument("--port", type=int, default=0, help="use a server already running on this port instead of a private one")
    ap.add_argument("--out", default=None, help="screenshot path, .png or .jpg (default <work>/shots/shot.png)")
    ap.add_argument("--quality", type=int, default=88, help="JPEG quality when --out ends in .jpg")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--shots", type=int, default=1, help="number of screenshots (0: none)")
    ap.add_argument("--interval", type=float, default=1.0, help="seconds between screenshots")
    ap.add_argument("--settle", type=float, default=1.5, help="seconds after ready before the first shot")
    ap.add_argument("--timeout", type=float, default=240, help="seconds to wait for ready")
    ap.add_argument("--force", action="store_true", help="shoot even if the app never became ready")
    ap.add_argument("--ready-expr", default="window.__ready === true")
    ap.add_argument("--fatal-expr", default="window.__fatal || null")
    ap.add_argument("--progress-expr", default="window.__progress !== undefined ? JSON.stringify(window.__progress)"
                    " : (window.__app ? 'window.__app exists' : 'no window.__app yet')")
    ap.add_argument("--stats-expr", default="window.__app && window.__app.stats ? JSON.stringify(window.__app.stats()) : null")
    ap.add_argument("--veil", default="#loading", help="CSS selector of a loading veil to wait out ('' for none)")
    ap.add_argument("--init", default=None, help="JS run in the page before its own scripts")
    ap.add_argument("--init-file", default=None)
    ap.add_argument("--pre", default=None, help="JS evaluated right after ready (before --settle); promises awaited")
    ap.add_argument("--pre-file", default=None)
    ap.add_argument("--eval", default=None, help="JS evaluated after the shots; result printed; promises awaited")
    ap.add_argument("--eval-file", default=None)
    ap.add_argument("--console", action="store_true", help="print every console message, not only errors and warnings")
    ap.add_argument("--fps", type=float, default=0, help="cap requestAnimationFrame at N/s from ready on (0: uncapped)")
    ap.add_argument("--heapprof", type=int, default=0, metavar="N", help="top N JS allocation sites from ready to the end")
    ap.add_argument("--heaplive", type=int, default=0, metavar="N", help="top N allocation sites still alive at the end")
    ap.add_argument("--heapdelay", type=float, default=0, metavar="S", help="start heap sampling S s after ready (skip warm-up)")
    ap.add_argument("--snapshot", default=None, metavar="PATH", help="collect garbage and save a heap snapshot at the end")
    ap.add_argument("--cpuprof", type=int, default=0, metavar="N", help="top N files/functions by self time, navigation to ready")
    ap.add_argument("--firstdraw", action="store_true", help="(three.js) list programs first drawn after ready")
    ap.add_argument("--profile", default=None, help="persistent Chrome profile dir (keeps the shader cache: warm starts)")
    ap.add_argument("--work", default=None, help="scratch dir for profiles and default outputs (default <root>/.work, or $SHOOT_WORK)")
    ap.add_argument("--wait-quiet", type=float, default=0, metavar="S", help="first wait up to S s for an idle machine")
    ap.add_argument("--require-gpu", action="store_true", help="exit 4 if WebGL runs on a software renderer")
    ap.add_argument("--max-seconds", type=float, default=None, help="hard limit for the run (exit 124); 0: none")
    ap.add_argument("--keep-open", action="store_true", help="keep the browser until Enter is pressed")
    ap.add_argument("--reap", action="store_true", help="only kill orphaned headless browsers of earlier runs, then exit")
    a = ap.parse_args()

    a.root = os.path.abspath(a.root)
    a.work = os.path.abspath(a.work or os.environ.get("SHOOT_WORK") or os.path.join(a.root, ".work"))
    os.makedirs(a.work, exist_ok=True)
    if a.reap:
        print(f"reap: {len(reap_orphans(a.work))} orphaned browser(s) killed")
        return 0
    reap_orphans(a.work)
    a.out = os.path.abspath(a.out or os.path.join(a.work, "shots", "shot.png"))
    a.init, a.pre, a.eval = read_js(a.init, a.init_file), read_js(a.pre, a.pre_file), read_js(a.eval, a.eval_file)
    if a.max_seconds is None:
        a.max_seconds = 0 if a.keep_open else a.wait_quiet + a.timeout + a.settle + a.heapdelay + a.shots * (a.interval + 5) + 900
    guard = ProcessGuard("shoot.py", a.max_seconds)
    try:
        return run(a, guard)
    except KeyboardInterrupt:
        return 130
    finally:
        guard.close()


def run(a, guard):
    if a.wait_quiet > 0:
        wait_quiet(a.wait_quiet)
    print("machine at start:", machine_load(), flush=True)
    port = a.port
    if not a.url and not port:
        port = start_server(a.root)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    profile = os.path.abspath(a.profile) if a.profile else tempfile.mkdtemp(prefix="shoot-", dir=a.work)
    if a.profile:
        os.makedirs(profile, exist_ok=True)
        try:
            os.remove(os.path.join(profile, "DevToolsActivePort"))   # (a previous run's)
        except OSError:
            pass
    errf = chrome_stderr()
    proc = guard.spawn(chrome_args(profile, a.width, a.height,
                                   ("--enable-precise-memory-info", "--autoplay-policy=no-user-gesture-required")),
                       stdout=errf, stderr=errf)
    rc, logs = 0, []
    try:
        ws_url = devtools_ws(profile, proc)
        if not ws_url:
            print("ERROR: chrome did not start (set SHOOT_STDERR=<file> to see why)", file=sys.stderr)
            return 2
        ws = WS(ws_url)
        sess = open_page(ws, a.width, a.height)

        def drain():
            for m in ws.events:
                if m.get("method") == "Runtime.consoleAPICalled":
                    p = m["params"]
                    logs.append((p.get("type"), " ".join(str(x.get("value", x.get("description", ""))) for x in p.get("args", []))))
                elif m.get("method") == "Runtime.exceptionThrown":
                    d = m["params"]["exceptionDetails"]
                    ex = d.get("exception", {}).get("description") or d.get("text")
                    logs.append(("exception", f"{ex} @ {d.get('url', '')}:{d.get('lineNumber')}"))
            ws.events.clear()

        def js(expr, timeout=120):
            r = ws.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True},
                        session=sess, timeout=timeout)
            drain()
            if "exceptionDetails" in r:
                return {"__error__": r["exceptionDetails"].get("exception", {}).get("description", str(r))}
            return r.get("result", {}).get("value")

        if not gpu_check(js) and a.require_gpu:
            return 4
        url = build_url(a, port)
        print("url:", url, flush=True)
        if a.cpuprof:
            ws.call("Profiler.enable", session=sess)
            ws.call("Profiler.setSamplingInterval", {"interval": 500}, session=sess)
            ws.call("Profiler.start", session=sess)
        if a.firstdraw:
            ws.call("Page.addScriptToEvaluateOnNewDocument", {"source": FIRSTDRAW_HOOK_JS}, session=sess)
        if a.init:
            ws.call("Page.addScriptToEvaluateOnNewDocument", {"source": a.init}, session=sess)
        ws.call("Page.navigate", {"url": url}, session=sess)

        t0, ready, fatal, next_note = time.time(), False, False, 30
        while time.time() - t0 < a.timeout:
            try:
                if js(a.ready_expr) is True:
                    ready = True
                    break
                err = js(a.fatal_expr)
                if err:
                    print("FATAL:", err)
                    fatal = True
                    break
                if time.time() - t0 > next_note:
                    next_note = time.time() - t0 + 30
                    print(f"  still loading after {time.time() - t0:.0f}s: {js(a.progress_expr)}", flush=True)
            except (TimeoutError, socket.timeout):   # main thread busy for 2 min (a long compile): keep waiting
                print(f"  the page did not answer for 120 s at {time.time() - t0:.0f}s", flush=True)
                continue
            time.sleep(0.25)
        print(f"ready={ready} after {time.time() - t0:.1f}s")
        if a.cpuprof:
            print_cpu_profile(ws.call("Profiler.stop", session=sess)["profile"], a.cpuprof, "navigation to ready")
        if not ready:
            rc = 1
            why = "a fatal error" if fatal else f"no ready within --timeout {a.timeout:.0f}s"
            print(f"WARNING: the app is NOT ready ({why}); " + ("shooting anyway (--force)" if a.force else "no screenshots"))
            print("last console messages before the failure:")
            drain()
            for typ, txt in logs[-40:]:
                print(f"  [{typ}] {txt[:600]}")
            if not a.force:
                a.shots = 0
        if ready and a.fps > 0:
            js(FPS_CAP_JS % a.fps)
            print(f"frame rate capped at {a.fps:g} fps")
        long_eval = max(120, a.max_seconds or 3600)
        if a.pre:
            print("pre:", show(js(a.pre, timeout=long_eval)), flush=True)
        if a.heapdelay > 0 and (a.heapprof or a.heaplive):
            time.sleep(a.heapdelay)
        heap_t0 = time.time()
        if a.heapprof or a.heaplive:
            ws.call("HeapProfiler.enable", session=sess)
            ws.call("HeapProfiler.startSampling", {"samplingInterval": 16384,
                    "includeObjectsCollectedByMajorGC": not a.heaplive, "includeObjectsCollectedByMinorGC": not a.heaplive}, session=sess)
        time.sleep(a.settle)
        if ready and a.shots:
            veil_gone(js, a.veil, "shoot.py")
        base, ext = os.path.splitext(a.out)
        fmt = "jpeg" if ext.lower() in (".jpg", ".jpeg") else "png"
        for i in range(a.shots):
            if i:
                time.sleep(a.interval)
            params = {"format": fmt, "captureBeyondViewport": False}
            if fmt == "jpeg":
                params["quality"] = a.quality
            shot = ws.call("Page.captureScreenshot", params, session=sess)
            path = a.out if a.shots == 1 else f"{base}_{i:02d}{ext}"
            with open(path, "wb") as f:
                f.write(base64.b64decode(shot["data"]))
            print("saved", path, f"{os.path.getsize(path) / 1048576:.2f} MB")
        stats = js(a.stats_expr) if a.stats_expr else None
        if stats:
            print("stats:", stats)
        if a.eval:
            print("eval:", show(js(a.eval, timeout=long_eval)))
        if a.firstdraw:
            rep = js(FIRSTDRAW_REPORT_JS)
            if isinstance(rep, dict):
                print(f"firstdraw: {rep['programs']} programs; {len(rep['late'])} first drawn after ready, {len(rep['never'])} never drawn")
                for e in rep["late"]:
                    print(f"  late  frame {e['frame']} where={e['where']} #{e['id']} {e['name']} ({e['born']}) [{', '.join(e['mats'])}]")
                for e in rep["never"][:40]:
                    print(f"  never #{e}")
            else:
                print("firstdraw: no data (needs window.__app.renderer)")
        if a.snapshot:
            ws.call("HeapProfiler.enable", session=sess)
            ws.call("HeapProfiler.collectGarbage", session=sess)
            os.makedirs(os.path.dirname(os.path.abspath(a.snapshot)), exist_ok=True)
            with open(a.snapshot, "w") as f:
                mid = ws.send("HeapProfiler.takeHeapSnapshot", {"reportProgress": False}, session=sess)
                ws.sock.settimeout(600)
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
            print_heap_profile(prof, a.heaplive or a.heapprof, time.time() - heap_t0)
        print("machine at end:", machine_load())
        drain()
        for typ, txt in logs:
            if a.console or typ in ("error", "warning", "exception", "assert"):
                print(f"[{typ}] {txt[:2000]}")
        if any(t in ("error", "exception") for t, _ in logs):
            rc = rc or 3
        if a.keep_open:
            input("press Enter to close")
    finally:
        guard.stop(proc)
        if errf is not subprocess.DEVNULL:
            errf.close()
        if not a.profile:
            shutil.rmtree(profile, ignore_errors=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
