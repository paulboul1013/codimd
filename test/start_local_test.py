"""Run with python3 test/start_local_test.py; no Docker required."""
import runpy
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


start_local = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'bin/start-local'))


class ServiceCheckTest(unittest.TestCase):
  def setUp(self):
    self.routes = {
      '/': ('text/html', b'<title>CodiMD</title><link rel="stylesheet" href="/style.css"><script src="/app.js"></script>'),
      '/style.css': ('text/css', b'body { color: red; }'),
      '/app.js': ('application/javascript', b'window.ready = true;')
    }
    routes = self.routes

    class Handler(BaseHTTPRequestHandler):
      def do_GET(self):
        if self.path not in routes:
          self.send_error(404)
          return
        mime, body = routes[self.path]
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.end_headers()
        self.wfile.write(body)

      def log_message(self, *_args):
        pass

    self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
    self.thread.start()
    self.addCleanup(self.close_server)
    self.url = f'http://127.0.0.1:{self.server.server_port}/'

  def close_server(self):
    self.server.shutdown()
    self.server.server_close()
    self.thread.join()

  def test_checks_stylesheets_and_scripts_over_http(self):
    self.assertEqual(start_local['check_service'](self.url), 2)

  def test_rejects_another_service_returning_http_200(self):
    self.routes['/'] = ('text/html', b'<title>Index of /</title>')
    with self.assertRaisesRegex(RuntimeError, 'CodiMD'):
      start_local['check_service'](self.url)

  def test_rejects_css_pointing_to_a_different_port(self):
    self.routes['/'] = ('text/html', b'<title>CodiMD</title><link rel="stylesheet" href="http://localhost:3100/style.css"><script src="/app.js"></script>')
    with self.assertRaisesRegex(RuntimeError, 'origin'):
      start_local['check_service'](self.url)

  def test_rejects_missing_css(self):
    del self.routes['/style.css']
    with self.assertRaisesRegex(RuntimeError, '404'):
      start_local['check_service'](self.url)

  def test_rejects_html_returned_as_css(self):
    self.routes['/style.css'] = ('text/html', b'<h1>Not CSS</h1>')
    with self.assertRaisesRegex(RuntimeError, 'text/css'):
      start_local['check_service'](self.url)

  def test_rejects_html_returned_as_javascript(self):
    self.routes['/app.js'] = ('text/html', b'<h1>Not JavaScript</h1>')
    with self.assertRaisesRegex(RuntimeError, 'JavaScript'):
      start_local['check_service'](self.url)

  def test_rejects_a_page_without_stylesheets(self):
    self.routes['/'] = ('text/html', b'<title>CodiMD</title><script src="/app.js"></script>')
    with self.assertRaisesRegex(RuntimeError, 'stylesheet'):
      start_local['check_service'](self.url)


if __name__ == '__main__':
  unittest.main()
