#!/usr/bin/env python3
"""Static server for the app: python3 serve.py [port]  ->  http://localhost:8080/"""
import http.server, socketserver, sys, os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
BIND = sys.argv[2] if len(sys.argv) > 2 else ""
os.chdir(os.path.dirname(os.path.abspath(__file__)))


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
with socketserver.ThreadingTCPServer((BIND, PORT), Handler) as httpd:
    print(f"Serving on http://localhost:{PORT}/  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
