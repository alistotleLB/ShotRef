import http.server, functools, sys
CSP="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; frame-src 'self'"
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path.startswith('/app'): self.send_header('Content-Security-Policy', CSP)
        super().end_headers()
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(('127.0.0.1',8765), functools.partial(H, directory=sys.argv[1])).serve_forever()
