#!/usr/bin/env python3
"""Static file server for a no-build ES-module web app.

    python3 serve.py [port] [--root DIR] [--bind ADDR] [--owner PID]

Defaults: port 8080, root = current directory, bind 127.0.0.1 (pass --bind 0.0.0.0 to
reach it from another machine or from a container with a published port).

Why not `python3 -m http.server`? It works for a person clicking around, but three things
bite an app that loads a few hundred modules at once and is captured by headless tools:
  * Listen backlog: socketserver's default request_queue_size is 5. A page that fires ~200
    module imports in one burst overflows it, the kernel drops connections, and a random
    dynamic import() fails ("Failed to fetch dynamically imported module"), maybe one start
    in 30. Here the backlog is 512 and every request gets its own thread.
  * MIME types: some systems map .js / .mjs to text/plain, and browsers refuse to run a
    module served that way. They are pinned to text/javascript here.
  * Caching: agents edit files between captures; a cached module means a screenshot of old
    code. Every response says Cache-Control: no-cache.
--owner PID makes the server exit by itself once that process is gone, so a capture tool
that dies can never leave its server behind.
"""
import argparse
import http.server
import os
import socketserver
import sys
import threading
import time

MIME = {
    ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
    ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
    ".ktx2": "image/ktx2", ".hdr": "application/octet-stream", ".exr": "application/octet-stream",
    ".bin": "application/octet-stream", ".webp": "image/webp", ".avif": "image/avif",
    ".glsl": "text/plain", ".wgsl": "text/plain",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **MIME}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):   # quiet: hundreds of module requests per page load
        pass

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):   # (the page navigated away mid-request)
            pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 512


def make_server(root, port=0, bind="127.0.0.1"):
    """A ready-to-run server for `root` (port 0 picks a free port: server.server_address[1])."""
    handler = lambda *a, **kw: Handler(*a, directory=root, **kw)   # noqa: E731
    return Server((bind, port), handler)


def _watch_owner(pid):
    while True:
        time.sleep(2)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            os._exit(0)
        except PermissionError:
            pass


def main():
    ap = argparse.ArgumentParser(description="no-cache static server with a deep request queue")
    ap.add_argument("port", nargs="?", type=int, default=8080)
    ap.add_argument("--root", default=os.getcwd(), help="directory to serve (default: current directory)")
    ap.add_argument("--bind", default="127.0.0.1", help="address to listen on (0.0.0.0: every interface)")
    ap.add_argument("--owner", type=int, default=0, help="exit when this process id is gone")
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    if a.owner:
        threading.Thread(target=_watch_owner, args=(a.owner,), daemon=True).start()
    with make_server(root, a.port, a.bind) as httpd:
        host = "localhost" if a.bind in ("127.0.0.1", "0.0.0.0", "") else a.bind
        print(f"Serving {root} on http://{host}:{httpd.server_address[1]}/  (Ctrl+C to stop)", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
