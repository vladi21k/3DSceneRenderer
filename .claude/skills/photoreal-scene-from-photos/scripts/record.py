#!/usr/bin/env python3
"""Offline video recorder: steps the app one fixed time step at a time in headless Chrome
(on the GPU), grabs every frame as a JPEG, and encodes an MP4 master plus a small phone copy.

Why offline: a live screen recording of a heavy WebGL scene stutters (a screenshot stalls the
frame it is taken in, and slow frames are slow). Here the page advances its clock by exactly
1/fps per frame however long the frame takes to render and grab, so the video plays smoothly
at full rate. A 30 s clip at 1080p takes a few minutes. No audio is captured.

  record.py --root ~/proj --name midday --params "s=700&tod=0.1" --seconds 40
  record.py --root ~/proj --name dusk --params "s=4000&tod=0.95" --seconds 20 --fps 30
  record.py --root ~/proj --name dusk --encode-only            (re-encode frames already grabbed)

Output in <work>/movies/<name>/: frames/00000.jpg..., <name>_1080p.mp4 (crf 18 master) and
<name>_phone.mp4 (1280 px wide, bitrate set so the file is about --phone-mb MB: uploads to a
phone over ~3 MB timed out, a 9 MB clip never arrived, 2-3.2 MB did).

App-side contract (defaults; change with --rec-param / --step-expr):
  rec=<fps> URL parameter: every frame advances the simulation by exactly 1/fps; the simulation
     holds still (dt = 0) while loading; once ready, the app stops its own requestAnimationFrame
     loop and renders only when stepped; the loading veil is removed at ready.
  window.__app.recStep(n): renders n frames synchronously and returns.
  window.__ready / window.__fatal as for shoot.py.
ffmpeg: the one on PATH, else `<this dir>/dk ffmpeg` (Docker tools image), or --ffmpeg "CMD".
"""
import argparse, base64, os, shlex, shutil, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shoot import (ProcessGuard, WS, build_url, chrome_args, chrome_stderr, devtools_ws, gpu_check,  # noqa: E402
                   machine_load, open_page, reap_orphans, start_server, veil_gone)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", default=os.getcwd(), help="directory to serve (default: current directory)")
    ap.add_argument("--page", default="index.html")
    ap.add_argument("--url", default=None, help="open this URL instead of serving --root")
    ap.add_argument("--name", default="ride")
    ap.add_argument("--params", default="", help="URL query for the app, without '?'")
    ap.add_argument("--capture-param", default="capture=1")
    ap.add_argument("--rec-param", default="rec={fps}", help="URL parameter that puts the app in fixed-step mode")
    ap.add_argument("--step-expr", default="window.__app.recStep(1)", help="JS that renders exactly one frame")
    ap.add_argument("--ready-expr", default="window.__ready === true")
    ap.add_argument("--fatal-expr", default="window.__fatal || null")
    ap.add_argument("--status-expr", default="", help="JS whose value is printed with the progress lines")
    ap.add_argument("--veil", default="#loading")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--warmup", type=int, default=60, help="frames stepped before recording (TAA history, staged reveal)")
    ap.add_argument("--settle", type=float, default=2.0, help="seconds after ready before the warm-up (background compiles)")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--quality", type=int, default=94, help="JPEG quality of the grabbed frames")
    ap.add_argument("--crf", type=int, default=18, help="x264 CRF of the master")
    ap.add_argument("--phone-mb", type=float, default=3.0, help="target size of the phone copy (0: no phone copy)")
    ap.add_argument("--phone-width", type=int, default=1280)
    ap.add_argument("--ffmpeg", default=None, help='ffmpeg command, e.g. "ffmpeg" or "/path/dk ffmpeg"')
    ap.add_argument("--work", default=None, help="scratch dir (default <root>/.work, or $SHOOT_WORK)")
    ap.add_argument("--out-dir", default=None, help="default <work>/movies/<name>")
    ap.add_argument("--timeout", type=float, default=300, help="seconds to wait for ready")
    ap.add_argument("--no-encode", action="store_true")
    ap.add_argument("--encode-only", action="store_true")
    ap.add_argument("--max-seconds", type=float, default=None,
                    help="hard limit for the browser part (default --timeout + 2 s per frame + 900; 0: none)")
    a = ap.parse_args()

    a.root = os.path.abspath(a.root)
    a.work = os.path.abspath(a.work or os.environ.get("SHOOT_WORK") or os.path.join(a.root, ".work"))
    a.out_dir = os.path.abspath(a.out_dir or os.path.join(a.work, "movies", a.name))
    os.makedirs(a.work, exist_ok=True)
    if a.encode_only:
        return encode(a)
    reap_orphans(a.work)
    if a.max_seconds is None:
        a.max_seconds = a.timeout + 2.0 * (a.warmup + a.seconds * a.fps) + 900
    guard = ProcessGuard("record.py", a.max_seconds)
    try:
        rc = capture(a, guard)
    except KeyboardInterrupt:
        rc = 130
    finally:
        guard.close()   # (the browser is gone before encoding starts)
    if rc or a.no_encode:
        return rc
    return encode(a)


def capture(a, guard):
    frames = os.path.join(a.out_dir, "frames")
    shutil.rmtree(frames, ignore_errors=True)
    os.makedirs(frames)
    print("machine at start:", machine_load(), flush=True)
    port = None if a.url else start_server(a.root)
    profile = tempfile.mkdtemp(prefix="record-", dir=a.work)
    errf = chrome_stderr()
    proc = guard.spawn(chrome_args(profile, a.width, a.height), stdout=errf, stderr=errf)
    errors = []
    try:
        ws_url = devtools_ws(profile, proc)
        if not ws_url:
            print("ERROR: chrome did not start", file=sys.stderr)
            return 2
        ws = WS(ws_url)
        sess = open_page(ws, a.width, a.height)

        def js(expr, timeout=120):
            r = ws.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True},
                        session=sess, timeout=timeout)
            for m in ws.events:
                if m.get("method") == "Runtime.consoleAPICalled" and m["params"].get("type") == "error":
                    errors.append(" ".join(str(x.get("value", x.get("description", ""))) for x in m["params"].get("args", [])))
                elif m.get("method") == "Runtime.exceptionThrown":
                    d = m["params"]["exceptionDetails"]
                    errors.append(d.get("exception", {}).get("description") or d.get("text"))
            ws.events.clear()
            if "exceptionDetails" in r:
                raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description", str(r)))
            return r.get("result", {}).get("value")

        gpu_check(js)
        a.params = "&".join(x for x in (a.params, a.rec_param.format(fps=a.fps)) if x)
        ws.call("Page.navigate", {"url": build_url(a, port)}, session=sess)
        t0 = time.time()
        while time.time() - t0 < a.timeout:
            if js(a.ready_expr) is True:
                break
            err = js(a.fatal_expr)
            if err:
                print("FATAL:", err)
                return 1
            time.sleep(0.25)
        else:
            print(f"ERROR: app not ready within {a.timeout:.0f}s; last errors: {errors[-5:]}")
            return 1
        print(f"ready after {time.time() - t0:.1f}s", flush=True)
        veil_gone(js, a.veil, "record.py")
        time.sleep(a.settle)
        for _ in range(a.warmup):
            js(a.step_expr)

        n = int(round(a.seconds * a.fps))
        t1 = time.time()
        for i in range(n):
            js(a.step_expr)
            shot = ws.call("Page.captureScreenshot", {"format": "jpeg", "quality": a.quality, "captureBeyondViewport": False},
                           session=sess)
            with open(os.path.join(frames, f"{i:05d}.jpg"), "wb") as f:
                f.write(base64.b64decode(shot["data"]))
            if i % (a.fps * 5) == 0 or i == n - 1:
                el = time.time() - t1
                st = js(a.status_expr) if a.status_expr else ""
                print(f"frame {i + 1}/{n}  {el / (i + 1) * 1000:.0f} ms/frame  eta {el / (i + 1) * (n - i - 1):.0f}s  {st or ''}",
                      flush=True)
        print(f"captured {n} frames in {time.time() - t1:.0f}s; console errors: {len(errors)}")
        for e in errors[:10]:
            print("  [error]", str(e)[:400])
    finally:
        guard.stop(proc)
        if errf is not subprocess.DEVNULL:
            errf.close()
        shutil.rmtree(profile, ignore_errors=True)
    return 3 if errors else 0


def ffmpeg_cmd(a):
    if a.ffmpeg:
        return shlex.split(a.ffmpeg)
    if shutil.which("ffmpeg"):
        return ["ffmpeg"]
    dk = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dk")
    if os.path.exists(dk) and shutil.which("docker"):
        return [dk, "ffmpeg"]
    sys.exit("ERROR: no ffmpeg on PATH and no docker for scripts/dk; pass --ffmpeg")


def encode(a):
    """Master and phone copy. ffmpeg runs with the movie folder as its working directory and
    relative paths, so it works the same through the dk Docker wrapper (which mounts the
    enclosing git repository, or the folder itself, and keeps the working directory)."""
    nframes = len([f for f in os.listdir(os.path.join(a.out_dir, "frames")) if f.endswith(".jpg")])
    if not nframes:
        print("ERROR: no frames to encode in", a.out_dir)
        return 1
    secs = nframes / a.fps
    ff = ffmpeg_cmd(a)
    common = ["-y", "-loglevel", "error", "-framerate", str(a.fps), "-i", "frames/%05d.jpg",
              "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    outs = [f"{a.name}_{a.height}p.mp4"]
    subprocess.run([*ff, *common, "-preset", "slow", "-crf", str(a.crf), outs[0]], check=True, cwd=a.out_dir)
    if a.phone_mb > 0:
        kbps = int(a.phone_mb * 8 * 1024 * 0.92 / secs)   # (8 % for the container and rate-control slack)
        outs.append(f"{a.name}_phone.mp4")
        subprocess.run([*ff, *common, "-vf", f"scale={a.phone_width}:-2:flags=lanczos", "-preset", "veryslow", "-crf", "28",
                        "-maxrate", f"{kbps}k", "-bufsize", f"{kbps}k", outs[1]], check=True, cwd=a.out_dir)
    for f in outs:
        p = os.path.join(a.out_dir, f)
        mb = os.path.getsize(p) / 1048576
        warn = "   <-- over the phone budget" if f.endswith("_phone.mp4") and mb > a.phone_mb * 1.1 else ""
        print(f"wrote {p}  {mb:.1f} MB  ({nframes} frames, {secs:.1f} s){warn}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
