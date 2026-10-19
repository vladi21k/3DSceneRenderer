#!/usr/bin/env python3
"""Offline movie recorder: renders the ride frame by frame and encodes MP4s.

The page runs with rec=<fps>, so every frame advances the clock by exactly 1/fps
however long it takes to render and grab; the result plays back smoothly at full
frame rate. Frames are grabbed as JPEGs through the DevTools protocol (headless
Chrome on the GPU, as tools/shoot.py), then encoded with ffmpeg in the tools image.

Examples
  tools/record.py --name midday --params "s=700&tod=0.1" --seconds 40
  tools/record.py --name dusk --params "s=4000&tod=0.95" --seconds 30 --fps 30
Outputs .work/movies/<name>/<name>_1080p.mp4 and <name>_phone.mp4 (720p, ~3 MB, for phones).
"""
import argparse, base64, json, os, random, shutil, subprocess, sys, tempfile, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shoot import ROOT, GPU_FLAGS, WS, free_port, port_open  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="ride")
    ap.add_argument("--params", default="", help="query string for the app (without leading ?)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--warmup", type=int, default=60, help="frames stepped before recording (TAA, staged reveal)")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--quality", type=int, default=94, help="JPEG quality of the grabbed frames")
    ap.add_argument("--timeout", type=float, default=250)
    ap.add_argument("--phone-mb", type=float, default=3.0, help="size of the phone copy (uploads over ~3 MB time out)")
    ap.add_argument("--no-encode", action="store_true")
    ap.add_argument("--encode-only", action="store_true", help="re-encode the frames already recorded")
    a = ap.parse_args()

    if a.encode_only:
        encode(a.name, a.fps, a.seconds, a.phone_mb)
        return 0
    out = os.path.join(ROOT, ".work/movies", a.name)
    frames = os.path.join(out, "frames")
    shutil.rmtree(frames, ignore_errors=True)
    os.makedirs(frames)

    port = free_port()
    server = subprocess.Popen([sys.executable, os.path.join(ROOT, "serve.py"), str(port), "127.0.0.1"],
                              cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        if port_open(port):
            break
        time.sleep(0.1)
    dbg = free_port()
    profile = tempfile.mkdtemp(prefix="record-", dir=os.path.join(ROOT, ".work"))
    chrome = shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
    proc = subprocess.Popen([chrome, "--headless=new", f"--remote-debugging-port={dbg}", f"--user-data-dir={profile}",
                             f"--window-size={a.width},{a.height}", "--hide-scrollbars", "--mute-audio",
                             "--no-first-run", "--no-default-browser-check", "--disable-extensions",
                             *os.environ.get("SHOOT_GPU_FLAGS", GPU_FLAGS).split(),
                             "--disable-gpu-vsync", "--disable-frame-rate-limit", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
        url = f"http://127.0.0.1:{port}/index.html?{a.params}{sep}capture=1&rec={a.fps}&cb={random.randint(0, 1 << 30)}"
        ws.call("Page.navigate", {"url": url}, session=sess)

        errors = []

        def js(expr):
            r = ws.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}, session=sess)
            for m in ws.events:
                if m.get("method") == "Runtime.consoleAPICalled" and m["params"].get("type") == "error":
                    errors.append(" ".join(str(x.get("value", x.get("description", ""))) for x in m["params"].get("args", [])))
                elif m.get("method") == "Runtime.exceptionThrown":
                    d = m["params"]["exceptionDetails"]
                    errors.append(d.get("exception", {}).get("description") or d.get("text"))
            ws.events.clear()
            return r.get("result", {}).get("value")

        t0 = time.time()
        while time.time() - t0 < a.timeout:
            if js("window.__ready === true") is True:
                break
            if js("window.__fatal || null"):
                print("FATAL:", js("window.__fatal"))
                return 1
            time.sleep(0.25)
        else:
            print("ERROR: app not ready")
            return 1
        print(f"ready after {time.time() - t0:.1f}s")
        time.sleep(2.0)   # background compiles of the first streamed chunks
        for _ in range(a.warmup):
            js("window.__app.recStep(1)")
            time.sleep(0.01)

        n = int(round(a.seconds * a.fps))
        t1 = time.time()
        for i in range(n):
            js("window.__app.recStep(1)")
            shot = ws.call("Page.captureScreenshot", {"format": "jpeg", "quality": a.quality, "captureBeyondViewport": False},
                           session=sess)
            with open(os.path.join(frames, f"{i:05d}.jpg"), "wb") as f:
                f.write(base64.b64decode(shot["data"]))
            if i % (a.fps * 5) == 0 or i == n - 1:
                st = json.loads(js("JSON.stringify(window.__app.stats())") or "{}")
                el = time.time() - t1
                print(f"frame {i + 1}/{n}  s={st.get('s')} m  {st.get('speedKmh')} km/h  "
                      f"{el / (i + 1) * 1000:.0f} ms/frame  eta {el / (i + 1) * (n - i - 1):.0f}s", flush=True)
        print(f"captured {n} frames in {time.time() - t1:.0f}s; console errors: {len(errors)}")
        for e in errors[:10]:
            print("  [error]", str(e)[:400])
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)
        server.terminate()

    if a.no_encode:
        return rc
    encode(a.name, a.fps, a.seconds, a.phone_mb)
    return rc


def encode(name, fps, seconds, phone_mb=3.0):
    """<name>_1080p.mp4 master, and <name>_phone.mp4: 720p sized to ~phone_mb, since
    files much over ~3 MB time out on the upload to a phone."""
    rel = os.path.relpath(os.path.join(ROOT, ".work/movies", name), ROOT)
    dk = os.path.join(ROOT, "tools/dk")
    common = ["-y", "-loglevel", "error", "-framerate", str(fps), "-i", f"{rel}/frames/%05d.jpg",
              "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    subprocess.run([dk, "ffmpeg", *common, "-preset", "slow", "-crf", "18",
                    f"{rel}/{name}_1080p.mp4"], check=True, cwd=ROOT)
    kbps = int(phone_mb * 8 * 1024 * 0.92 / seconds)
    subprocess.run([dk, "ffmpeg", *common, "-vf", "scale=1280:-2:flags=lanczos", "-preset", "veryslow", "-crf", "28",
                    "-maxrate", f"{kbps}k", "-bufsize", f"{kbps}k", f"{rel}/{name}_phone.mp4"], check=True, cwd=ROOT)
    for f in (f"{name}_1080p.mp4", f"{name}_phone.mp4"):
        p = os.path.join(ROOT, rel, f)
        print(f"wrote {os.path.relpath(p, ROOT)}  {os.path.getsize(p) / 1048576:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
