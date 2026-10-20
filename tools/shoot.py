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
  tools/shoot.py --params "speed=50" --shots 0 --settle 30 --heapprof 30 --heapdelay 40 (warm allocation sites)
  tools/shoot.py --profile .work/prof --params "s=100&speed=60" --shots 0 --settle 30 --firstdraw (late first draws)
  tools/shoot.py --reap   (kill headless browsers left behind by runs whose tool is gone)

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

Browser lifetime: Chrome and the server run in process groups of their own, and the whole
group is killed when the tool ends: normally, on an exception, on SIGTERM / SIGINT / SIGHUP
(as `timeout` sends), at interpreter exit, and, through a small watchdog process that
holds a pipe to the tool, even when the tool itself is killed with SIGKILL. --max-seconds
bounds the whole run (default: --timeout + --settle + the shots + 15 min; 0: no limit).
Every run first reaps headless browsers left behind by an earlier run whose tool is gone
(--reap does only that).
"""
import argparse, atexit, base64, json, os, random, shutil, signal, socket, struct, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GPU_FLAGS = "--enable-gpu --ignore-gpu-blocklist --use-angle=gl"
# Chrome ignores switches it does not know: this one tags a browser with the pid of the tool
# that started it, so a browser whose tool is gone can be recognised as an orphan.
OWNER_FLAG = "--shoot-owner="


# ---- process lifetime: no browser may outlive the tool that started it
#
# Each child (Chrome, serve.py) is started in a new session, so it and everything it forks
# (Chrome's zygotes, GPU process and renderers) share one process group that can be killed
# as a whole. The watchdog is a separate tiny process in its own session: the tool tells it
# the groups over a pipe, and when the pipe closes (the tool exited, crashed or was killed
# with SIGKILL) or the --max-seconds deadline passes, it kills those groups.

_WATCHDOG = r"""
import os, select, signal, sys, time
for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(s, signal.SIG_IGN)
parent, deadline, label = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
groups, buf = set(), b""

def alive(g):
    try:
        os.killpg(g, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False

def kill_groups():
    for sig, grace in ((signal.SIGTERM, 3.0), (signal.SIGKILL, 2.0)):
        for g in list(groups):
            try:
                os.killpg(g, sig)
            except (ProcessLookupError, PermissionError):
                groups.discard(g)
        end = time.time() + grace
        while groups and time.time() < end:
            for g in list(groups):
                if not alive(g):
                    groups.discard(g)
            time.sleep(0.05)
        if not groups:
            return

while True:
    wait = None if deadline <= 0 else max(0.0, deadline - time.time())
    r, _, _ = select.select([0], [], [], wait)
    if not r:
        if groups:
            sys.stderr.write(f"{label} watchdog: --max-seconds passed and the tool did not stop; killing its browser\n")
        kill_groups()
        try:
            os.kill(parent, signal.SIGTERM)
            time.sleep(10)
            os.kill(parent, signal.SIGKILL)
        except ProcessLookupError:
            pass
        break
    chunk = os.read(0, 4096)
    if not chunk:
        kill_groups()
        break
    buf += chunk
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        op, _, g = line.partition(b" ")
        if op == b"+":
            groups.add(int(g))
        elif op == b"-":
            groups.discard(int(g))
"""


class Overrun(SystemExit):
    """Raised in the tool when --max-seconds passes."""


class ProcessGuard:
    """Starts child processes in their own process groups and makes sure every group is gone
    when the tool ends, however it ends. One per tool run: guard = ProcessGuard(label, max_s);
    guard.spawn([...]); ... guard.close() (also called at exit and on signals)."""

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
            # (the backstop fires 30 s after the tool's own --max-seconds alarm)
            deadline = time.time() + self.max_seconds + 30 if self.max_seconds > 0 else 0
            self._wd = subprocess.Popen([sys.executable, "-c", _WATCHDOG, str(os.getpid()), repr(deadline), label],
                                        stdin=r, stdout=subprocess.DEVNULL, start_new_session=True)
            os.close(r)
            self._pipe = w
        except OSError as e:
            print(f"WARNING: {label}: no watchdog ({e}); browsers are still killed at exit", file=sys.stderr)

    def _tell(self, msg):
        if self._pipe is None:
            return
        try:
            os.write(self._pipe, msg.encode())
        except OSError:
            pass

    def _on_signal(self, sig, frame):
        name = signal.Signals(sig).name
        print(f"{self.label}: {name} received, closing the browser", file=sys.stderr, flush=True)
        if sig == signal.SIGINT:
            raise KeyboardInterrupt
        raise SystemExit(128 + sig)

    def _on_alarm(self, sig, frame):
        print(f"{self.label}: --max-seconds {self.max_seconds:g} passed, closing the browser", file=sys.stderr, flush=True)
        raise Overrun(124)

    def spawn(self, args, **kw):
        """subprocess.Popen in a new session (process group = its pid), registered for cleanup."""
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
        """Ends one child and its whole process group: SIGTERM to the child (Chrome shuts
        down cleanly and writes its caches), then SIGTERM and SIGKILL to the group."""
        g = p.pid
        steps = ((None, grace), (signal.SIGTERM, 2.0), (signal.SIGKILL, 2.0))
        for sig, wait in steps:
            try:
                if sig is None:
                    p.terminate()
                else:
                    os.killpg(g, sig)
            except (ProcessLookupError, PermissionError):
                pass
            end = time.time() + wait
            while time.time() < end:
                p.poll()   # (reaps the child itself, so its zombie does not keep the group alive)
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
        """Stops every child (newest first) and the watchdog. Idempotent; signals are held off
        while it runs so a second Ctrl-C or timeout signal cannot cut the cleanup short."""
        if self.closed:
            return
        self.closed = True
        try:
            signal.alarm(0)
        except Exception:
            pass
        old = {}
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
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


def _pgid(pid):
    try:
        return os.getpgid(pid)
    except OSError:
        return None


def _runs_script(pid):
    """True while pid is alive and runs a Python script (a capture tool or a scratch copy)."""
    c = _cmdline(int(pid))
    return bool(c) and any(x.endswith(b".py") for x in c)


def reap_orphans(verbose=True):
    """Kills headless browsers that a capture tool left behind: a browser tagged with
    --shoot-owner=<pid> whose tool is gone, or an untagged one (from an older or scratch
    copy of the tools) with its profile under .work/ whose parent is no longer a Python
    script (it was re-parented when its tool died). Browsers of tools still running, and
    browsers outside this repository, are left alone. Returns the pids of those killed."""
    me = os.getuid()
    work = (os.path.join(ROOT, ".work") + os.sep).encode()
    reaped = []
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        pid = int(d)
        c = _cmdline(pid)
        if not c or not any(x.startswith(b"--headless") for x in c) or any(x.startswith(b"--type=") for x in c):
            continue
        try:
            if os.stat(f"/proc/{pid}").st_uid != me:
                continue
        except OSError:
            continue
        owner = next((x[len(OWNER_FLAG):] for x in c if x.startswith(OWNER_FLAG.encode())), None)
        if owner is not None:
            if owner.isdigit() and _runs_script(owner):
                continue
        else:
            prof = next((x.split(b"=", 1)[1] for x in c if x.startswith(b"--user-data-dir=")), b"")
            if not os.path.abspath(prof).startswith(work):
                continue
            try:
                with open(f"/proc/{pid}/stat") as f:
                    ppid = int(f.read().rsplit(")", 1)[1].split()[1])
            except (OSError, ValueError, IndexError):
                continue
            if _runs_script(ppid):
                continue
        g = _pgid(pid)
        try:
            if g == pid:
                os.killpg(g, signal.SIGKILL)   # (its own group: the renderers and GPU process go too)
            else:
                os.kill(pid, signal.SIGKILL)
            reaped.append(pid)
        except (ProcessLookupError, PermissionError):
            pass
    servers = _reap_servers()
    _clean_profiles()
    if reaped and verbose:
        print(f"reaped {len(reaped)} orphaned headless browser(s) left by an earlier run: pids {reaped}", flush=True)
    if servers and verbose:
        print(f"reaped {len(servers)} orphaned static server(s): pids {servers}", flush=True)
    return reaped


def _clean_profiles(min_age=900):
    """Deletes the scratch profiles (.work/shoot-*, .work/record-*) of runs that did not get
    to delete their own: older than min_age seconds and named by no running process."""
    work = os.path.join(ROOT, ".work")
    try:
        names = [n for n in os.listdir(work) if n.startswith(("shoot-", "record-"))]
    except OSError:
        return 0
    if not names:
        return 0
    used = set()
    for d in os.listdir("/proc"):
        if d.isdigit():
            for x in _cmdline(int(d)) or ():
                if x.startswith(b"--user-data-dir="):
                    used.add(os.path.basename(x[16:].rstrip(b"/")).decode("utf-8", "replace"))
    now, n = time.time(), 0
    for name in names:
        path = os.path.join(work, name)
        try:
            if name in used or not os.path.isdir(path) or now - os.stat(path).st_mtime < min_age:
                continue
        except OSError:
            continue
        shutil.rmtree(path, ignore_errors=True)
        n += 1
    return n


def _reap_servers():
    """Static servers (serve.py, or a scratch copy under this repository) a capture tool left
    behind: tagged --owner=<pid> of a process that is gone, or untagged in the tools' form
    'serve.py <port> 127.0.0.1' and re-parented to init or the user's service manager."""
    me, out = os.getuid(), []
    root = ROOT.encode() + b"/"
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        pid = int(d)
        c = _cmdline(pid)
        if not c or len(c) < 2:
            continue
        i = next((k for k, x in enumerate(c) if x.endswith(b"serve.py")), -1)
        if i < 0 or not os.path.abspath(c[i]).startswith(root):
            continue
        try:
            if os.stat(f"/proc/{pid}").st_uid != me:
                continue
            with open(f"/proc/{pid}/stat") as f:
                ppid = int(f.read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            continue
        rest = [x for x in c[i + 1:] if x]
        owner = next((x[8:] for x in rest if x.startswith(b"--owner=")), None)
        if owner is not None:
            if owner.isdigit() and _cmdline(int(owner)) is not None:
                continue
        else:
            if len(rest) != 2 or rest[1] != b"127.0.0.1" or not rest[0].isdigit():
                continue
            try:
                with open(f"/proc/{ppid}/comm") as f:
                    pcomm = f.read().strip()
            except OSError:
                pcomm = ""
            if ppid != 1 and pcomm != "systemd":
                continue
        try:
            os.kill(pid, signal.SIGKILL)
            out.append(pid)
        except (ProcessLookupError, PermissionError):
            pass
    return out


def chrome_args(dbg, profile, width, height, extra=()):
    """The headless Chrome command line both tools use (GPU on, vsync and frame cap off).
    SHOOT_GPU_FLAGS replaces the GPU switches; SHOOT_CHROME_FLAGS adds switches (for example
    --js-flags=--trace-deopt, with SHOOT_STDERR=<file> to keep Chrome's output)."""
    chrome = shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
    return [chrome, "--headless=new", f"--remote-debugging-port={dbg}", f"--user-data-dir={profile}",
            f"--window-size={width},{height}", "--hide-scrollbars", "--mute-audio",
            "--no-first-run", "--no-default-browser-check", "--disable-extensions",
            *extra,
            *os.environ.get("SHOOT_GPU_FLAGS", GPU_FLAGS).split(), *os.environ.get("SHOOT_CHROME_FLAGS", "").split(),
            "--disable-gpu-vsync", "--disable-frame-rate-limit",
            f"{OWNER_FLAG}{os.getpid()}", "about:blank"]


def devtools_ws(profile, proc, timeout=30.0):
    """The browser's DevTools websocket URL. Chrome runs with --remote-debugging-port=0, picks a
    free port itself and writes it to <profile>/DevToolsActivePort, so runs started at the same
    moment can never meet on one port (and drive each other's browser). None if Chrome exits
    or does not answer within timeout."""
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
    """Where Chrome's own output goes: SHOOT_STDERR=<file> keeps it, else it is discarded."""
    path = os.environ.get("SHOOT_STDERR")
    return open(path, "w") if path else subprocess.DEVNULL


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


# --firstdraw: from page start, note the first non-empty draw of every WebGL program (draw
# calls, instanced draws and multi-draws with a count above 0), so programs first drawn after
# ready can be listed: each such first draw costs the GPU process 100-250 ms mid-ride.
FIRSTDRAW_HOOK_JS = r"""(() => {
  if (window.__firstUse || typeof WebGL2RenderingContext === 'undefined') return;
  const P = WebGL2RenderingContext.prototype, seen = new Map(), cur = new WeakMap(), made = new Map();
  window.__firstUse = seen; window.__made = made;
  const state = () => { const a = window.__app; return { frame: a ? a.frame : -1, s: a && a.cameraS != null ? a.cameraS : null, ready: !!(a && a.ready) }; };
  const cp = P.createProgram;
  P.createProgram = function () { const p = cp.call(this); made.set(p, state()); return p; };
  const use = P.useProgram;
  P.useProgram = function (p) { cur.set(this, p); return use.call(this, p); };
  const mark = (gl) => { const p = cur.get(gl); if (p && !seen.has(p)) seen.set(p, state()); };
  const cnt = { drawElements: (a) => a[1], drawArrays: (a) => a[2], drawElementsInstanced: (a) => a[1] * a[4], drawArraysInstanced: (a) => a[2] * a[3], drawRangeElements: (a) => a[3] };
  for (const n of Object.keys(cnt)) {
    const f = P[n]; if (!f) continue;
    P[n] = function (...a) { if (cnt[n](a) > 0) mark(this); return f.apply(this, a); };
  }
  const ge = P.getExtension;
  P.getExtension = function (name) {
    const ext = ge.call(this, name);
    if (ext && /multi_draw/i.test(name) && !ext.__probe) {
      const gl = this; ext.__probe = true;
      for (const n of Object.getOwnPropertyNames(Object.getPrototypeOf(ext))) {
        if (!/^multiDraw/.test(n)) continue;
        const f = ext[n];
        ext[n] = function (...a) { if (a[a.length - 1] > 0) mark(gl); return f.apply(ext, a); };
      }
    }
    return ext;
  };
})();"""

FIRSTDRAW_REPORT_JS = r"""(() => {
  const app = window.__app, r = app && app.renderer, seen = window.__firstUse, made = window.__made;
  if (!r || !seen) return null;
  const byGl = new Map();
  for (const p of r.info.programs || []) byGl.set(p.program, { id: p.id, name: p.name, mats: [] });
  app.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material.slice() : o.material ? [o.material] : [];
    if (o.customDepthMaterial) ms.push(o.customDepthMaterial);
    for (const m of ms) {
      const pr = r.properties.get(m).currentProgram;
      const e = pr && byGl.get(pr.program);
      if (!e) continue;
      const nm = (o.name || o.type) + '/' + (m.name || m.type);
      if (!e.mats.includes(nm) && e.mats.length < 4) e.mats.push(nm);
    }
  });
  const late = [], never = [];
  for (const [gp, e] of byGl) {
    const u = seen.get(gp), c = made && made.get(gp);
    const born = c ? (c.ready ? 'created after ready, frame ' + c.frame : 'start-up') : '?';
    if (!u) never.push(e.id + ' ' + e.name + ' [' + e.mats.join(', ') + ']');
    else if (u.ready) late.push({ id: e.id, name: e.name, frame: u.frame, s: u.s == null ? null : +u.s.toFixed(1), born, mats: e.mats });
  }
  late.sort((x, y) => x.frame - y.frame);
  return { frame: app.frame, s: +(app.cameraS || 0).toFixed(1), programs: byGl.size, late, never };
})()"""


def print_firstdraw(rep):
    if not isinstance(rep, dict):
        print("firstdraw: no data", json.dumps(rep))
        return
    late, never = rep.get("late", []), rep.get("never", [])
    print(f"firstdraw: {rep['programs']} programs at frame {rep['frame']} (s={rep['s']}): "
          f"{len(late)} first drawn after ready, {len(never)} never drawn")
    for e in late:
        print(f"  late  frame {e['frame']} s={e['s']}  #{e['id']} {e['name']} ({e['born']})  [{', '.join(e['mats'])}]")
    for e in never[:40]:
        print(f"  never #{e}")


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
    ap.add_argument("--init", default=None, metavar="JS",
                    help="JS evaluated in the page before its own scripts (to hook or stub browser APIs for a test)")
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
    ap.add_argument("--heapdelay", type=float, default=0, metavar="S",
                    help="with --hitches/--heapprof/--heaplive: start sampling S seconds after ready instead of at "
                         "ready (frame statistics and the frame samples are reset then too), so a short run is not "
                         "dominated by warm-up allocation while the code is not yet optimised")
    ap.add_argument("--firstdraw", action="store_true",
                    help="audit first draws: hook WebGL from page start and, at the end, list every program whose first "
                         "non-empty draw came after ready (each costs the GPU process 100-250 ms mid-ride) and "
                         "programs never drawn. Time this with a warm --profile: fresh profiles hide first-draw stalls")
    ap.add_argument("--max-seconds", type=float, default=None, metavar="S",
                    help="hard limit for the whole run, after which the browser is killed and the tool exits 124 "
                         "(default --timeout + --settle + the shots + 900; 0: no limit)")
    ap.add_argument("--reap", action="store_true",
                    help="only kill headless browsers left behind by earlier runs whose tool is gone, then exit")
    ap.add_argument("--keep-open", action="store_true")
    ap.add_argument("--profile", default=None, help="persistent Chrome profile dir (keeps the GPU shader cache between runs)")
    a = ap.parse_args()

    if a.reap:
        n = len(reap_orphans())
        print(f"reap: {n} orphaned browser(s) killed")
        return 0
    reap_orphans()
    if a.max_seconds is None:
        a.max_seconds = 0 if a.keep_open else a.timeout + a.settle + a.shots * (a.interval + 5) + 900
    guard = ProcessGuard("shoot.py", a.max_seconds)
    try:
        return run(a, guard)
    except KeyboardInterrupt:
        return 130
    finally:
        guard.close()


def run(a, guard):
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    timing = a.hitches or a.heapprof or a.heaplive
    if a.fps is None:
        a.fps = 60 if timing else 0
    if timing:
        print("machine at start:", machine_load())
    server = None
    if not a.port:
        a.port = free_port()
        server = guard.spawn([sys.executable, os.path.join(ROOT, "serve.py"), str(a.port), "127.0.0.1", f"--owner={os.getpid()}"],
                             cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            if port_open(a.port):
                break
            time.sleep(0.1)

    os.makedirs(os.path.join(ROOT, ".work"), exist_ok=True)
    profile = os.path.abspath(a.profile) if a.profile else tempfile.mkdtemp(prefix="shoot-", dir=os.path.join(ROOT, ".work"))
    if a.profile:
        os.makedirs(profile, exist_ok=True)
        try:
            os.remove(os.path.join(profile, "DevToolsActivePort"))   # (a previous run's)
        except OSError:
            pass
    args = chrome_args(0, profile, a.width, a.height, ("--enable-precise-memory-info", "--autoplay-policy=no-user-gesture-required"))
    errf = chrome_stderr()
    proc = guard.spawn(args, stdout=errf, stderr=errf)
    rc = 0
    try:
        ws_url = devtools_ws(profile, proc)
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
        if a.firstdraw:
            ws.call("Page.addScriptToEvaluateOnNewDocument", {"source": FIRSTDRAW_HOOK_JS}, session=sess)
        if a.init:
            ws.call("Page.addScriptToEvaluateOnNewDocument", {"source": a.init}, session=sess)
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
            try:
                if js("window.__ready === true") is True:
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
            except TimeoutError:   # (socket.timeout too) the page's main thread did not answer for 2 minutes: wait on
                print(f"  the page did not answer for 120 s (its main thread busy) at {time.time() - t0:.0f}s", flush=True)
                continue
            time.sleep(0.25)
        print(f"ready={ready} after {time.time() - t0:.1f}s")
        if ready:
            # (main.js: the browser held back the animation frames during the start-up)
            st = js("JSON.stringify((window.__app && window.__app.perf.init.firstFrameStall) || null)")
            if st and st != "null":
                print(f"first frames held back by the browser: {st}", flush=True)
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
        if a.heapdelay > 0 and timing:
            print(f"waiting {a.heapdelay:g}s before sampling (--heapdelay)", flush=True)
            time.sleep(a.heapdelay)
        if a.hitches or (a.heapdelay > 0 and timing):
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
        if a.firstdraw:
            rep = js(FIRSTDRAW_REPORT_JS)
            print_firstdraw(rep)
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
        guard.stop(proc)
        if server:
            guard.stop(server)
        if errf is not subprocess.DEVNULL:
            errf.close()
        if not a.profile:
            shutil.rmtree(profile, ignore_errors=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
