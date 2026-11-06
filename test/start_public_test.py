"""Run with python3 test/start_public_test.py; no Docker required."""
import contextlib
import io
import subprocess
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock


start_public = SourceFileLoader('start_public', str(Path(__file__).resolve().parents[1] / 'bin/start-public')).load_module()


class StopHolding(Exception):
  pass


class PagesFailureTest(unittest.TestCase):
  def run_main(self, *args, publish=None, wait=None):
    stderr = io.StringIO()
    patches = {
      'wait_for_docker': mock.Mock(),
      'start_tunnel': mock.Mock(return_value='https://tunnel.example'),
      'start_app': mock.Mock(),
      'wait_for_public': mock.Mock(return_value=3),
      'publish_pages': publish or mock.Mock(return_value='https://pages.example/'),
      'wait_for_pages': wait or mock.Mock()
    }
    with mock.patch.multiple(start_public, **patches), \
        mock.patch('sys.argv', ['start-public', *args]), \
        mock.patch.object(start_public.time, 'sleep', side_effect=StopHolding), \
        contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
      try:
        return start_public.main(), stderr.getvalue()
      except StopHolding:
        return 'held', stderr.getvalue()

  def test_holds_when_pages_is_healthy(self):
    self.assertEqual(self.run_main('--hold'), ('held', ''))

  def test_holds_when_pages_deploy_is_slow(self):
    result, stderr = self.run_main('--hold', wait=mock.Mock(side_effect=RuntimeError('slow deploy')))
    self.assertEqual(result, 'held')
    self.assertIn('slow deploy', stderr)

  def test_holds_when_publishing_fails(self):
    failure = subprocess.CalledProcessError(1, 'gh')
    result, stderr = self.run_main('--hold', publish=mock.Mock(side_effect=failure))
    self.assertEqual(result, 'held')
    self.assertIn('gh', stderr)

  def test_reports_failure_without_hold(self):
    result, _ = self.run_main(wait=mock.Mock(side_effect=RuntimeError('slow deploy')))
    self.assertEqual(result, 1)

  def test_stops_when_the_site_itself_fails(self):
    stderr = io.StringIO()
    patches = {
      'wait_for_docker': mock.Mock(),
      'start_tunnel': mock.Mock(return_value='https://tunnel.example'),
      'start_app': mock.Mock(),
      'wait_for_public': mock.Mock(side_effect=RuntimeError('down'))
    }
    with mock.patch.multiple(start_public, **patches), mock.patch('sys.argv', ['start-public', '--hold']), \
        contextlib.redirect_stderr(stderr):
      self.assertEqual(start_public.main(), 1)
    self.assertIn('down', stderr.getvalue())


if __name__ == '__main__':
  unittest.main()
