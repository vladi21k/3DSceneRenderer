#!/usr/bin/env python3
"""Static server for the app: python3 serve.py [port] [bind]  ->  http://localhost:8080/

The capture tools add --owner=<pid>: the server then exits by itself once that process is
gone, so a tool that dies can never leave its server behind."""
import http.server, socketserver, sys, os, threading, time

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
OWNER = next((int(a[8:]) for a in sys.argv[1:] if a.startswith("--owner=") and a[8:].isdigit()), 0)
PORT = int(ARGS[0]) if len(ARGS) > 0 else 8080
BIND = ARGS[1] if len(ARGS) > 1 else ""
os.chdir(os.path.dirname(os.path.abspath(__file__)))


def watch_owner(pid):
    while True:
        time.sleep(2)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            os._exit(0)
        except PermissionError:
            pass


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
                      ".glb": "model/gltf-binary", ".ktx2": "image/ktx2", ".hdr": "application/octet-stream"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *a):
        pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer.request_queue_size = 512   # the app fetches ~200 modules at once
socketserver.ThreadingTCPServer.daemon_threads = True
if OWNER:
    threading.Thread(target=watch_owner, args=(OWNER,), daemon=True).start()
with socketserver.ThreadingTCPServer((BIND, PORT), Handler) as httpd:
    print(f"Serving on http://localhost:{PORT}/  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
