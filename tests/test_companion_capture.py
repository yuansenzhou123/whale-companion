import importlib.util
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('capture_client', ROOT/'companion/desktop/capture_client.py')
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)

class CaptureTests(unittest.TestCase):
    def test_automatic_bounds_follow_move_resize_fullscreen_and_second_monitor(self):
        import win32gui
        for rect, origin in [((0, 0, 1000, 500), (100, 200)), ((0, 0, 800, 600), (-900, 0)), ((0, 0, 1920, 1080), (0, 0))]:
            with self.subTest(rect=rect, origin=origin), \
                 patch.object(win32gui, 'GetClientRect', return_value=rect), \
                 patch.object(win32gui, 'ClientToScreen', side_effect=lambda h, p: (origin[0]+p[0], origin[1]+p[1])):
                self.assertEqual(capture.window_box(1), (origin[0], origin[1], origin[0]+rect[2], origin[1]+rect[3]))

    def drive(self, foreground=True, enabled=True, frames=True, minimized=False, rect=(0, 0, 1000, 500)):
        import requests
        import win32api, win32event, win32gui, win32process
        from PIL import Image, ImageGrab
        # A stale manual crop from an older installation must not affect auto capture.
        state = {'settings': {'enabled': enabled, 'framesEnabled': frames, 'captureRegion': {'x': .8, 'y': .8, 'width': .1, 'height': .1}, 'analysisIntervalSeconds': 35}, 'needFrame': False}
        http = Mock()
        http.get.side_effect = [Mock(json=lambda: {'token': 'test'}), Mock(status_code=200, json=lambda: state)]
        http.post.return_value.status_code = 200
        child = Mock(stdout=io.BytesIO(b''))
        parent = Mock()
        fake_lock = Mock()
        with patch.object(sys, 'argv', ['capture_client.py', 'http://127.0.0.1:12345', '123']), \
             patch.object(capture.time, 'sleep'), patch.object(capture, 'matching_process', return_value=foreground), \
             patch.object(capture.socket, 'socket', return_value=fake_lock), \
             patch.object(capture.subprocess, 'Popen', return_value=child), \
             patch.object(requests, 'Session', return_value=http), \
             patch.object(win32api, 'OpenProcess', return_value=parent), \
             patch.object(win32event, 'WaitForSingleObject', side_effect=[258, 0]), \
             patch.object(win32gui, 'GetForegroundWindow', return_value=1), \
             patch.object(win32gui, 'IsIconic', return_value=minimized), \
             patch.object(win32gui, 'GetClientRect', return_value=rect), \
             patch.object(win32gui, 'ClientToScreen', side_effect=lambda h, p: (100+p[0], 100+p[1])), \
             patch.object(win32process, 'GetWindowThreadProcessId', return_value=(1, 2)), \
             patch.object(ImageGrab, 'grab', return_value=Image.new('RGB', (1000, 500), '#1469a5')) as grab:
            capture.main()
        child.terminate.assert_called_once()
        parent.Close.assert_called_once()
        return grab, http

    def test_entire_client_is_sent_without_manual_selection(self):
        grab, http = self.drive()
        grab.assert_called_once_with(bbox=(100, 100, 1100, 600), all_screens=True)
        event = http.post.call_args.kwargs['json']
        self.assertEqual(event['source'], 'desktop')
        self.assertTrue(event['url'].startswith('desktop://bilibili/'))
        self.assertTrue(event['frame'].startswith('data:image/jpeg;base64,'))

    def test_other_foreground_app_is_not_captured(self):
        grab, http = self.drive(foreground=False)
        grab.assert_not_called()
        http.post.assert_not_called()

    def test_disabled_minimized_or_invalid_window_never_captures(self):
        for options in [dict(enabled=False), dict(minimized=True), dict(rect=(0, 0, 0, 0))]:
            with self.subTest(**options):
                grab, http = self.drive(**options)
                grab.assert_not_called()
                http.post.assert_not_called()

    def test_turning_off_frame_upload_omits_image(self):
        grab, http = self.drive(frames=False)
        self.assertNotIn('frame', http.post.call_args.kwargs['json'])

if __name__ == '__main__':
    unittest.main(verbosity=2)
