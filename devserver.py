#!/usr/bin/env python3
"""Static dev server with caching disabled, so edits to the JS/CSS always show
up on reload (python's plain http.server lets browsers heuristically cache
them, which makes it look like changes did nothing).

    python3 devserver.py [port]      # default 4461
"""
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4461


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("", PORT), NoCacheHandler).serve_forever()
