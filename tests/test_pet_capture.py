import ctypes
from ctypes import wintypes
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'companion/desktop'))
from live2d_pet import apply_capture_policy
from live2d_renderer import DEFAULT_MODEL
from pet_controls import VisualCatalog,VisualControls

class CapturePreferenceTests(unittest.TestCase):
    def test_choice_survives_restart_and_other_visual_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/'controls.json'
            catalog=VisualCatalog(DEFAULT_MODEL)
            controls=VisualControls(catalog,file)
            self.assertFalse(controls.allow_capture)
            controls.set_allow_capture(True)
            controls.toggle('鲸鱼')
            controls.set_face('脸红')
            restored=VisualControls(catalog,file)
            self.assertTrue(restored.allow_capture)
            self.assertIn('鲸鱼',restored.enabled)
            self.assertEqual(restored.manual_face,'脸红')
            restored.set_allow_capture(False)
            self.assertFalse(VisualControls(catalog,file).allow_capture)

    def test_native_window_capture_affinity_really_changes(self):
        import win32gui,win32con
        hwnd=win32gui.CreateWindowEx(win32con.WS_EX_LAYERED,'Static','WhaleCapturePolicyTest',win32con.WS_POPUP,0,0,80,80,0,0,0,None)
        user32=ctypes.WinDLL('user32',use_last_error=True)
        read=user32.GetWindowDisplayAffinity
        read.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD)]
        read.restype=wintypes.BOOL
        try:
            for allowed,expected in [(False,0x11),(True,0),(False,0x11)]:
                apply_capture_policy(hwnd,allowed)
                value=wintypes.DWORD()
                self.assertTrue(read(hwnd,ctypes.byref(value)))
                self.assertEqual(value.value,expected)
        finally:win32gui.DestroyWindow(hwnd)

if __name__=='__main__':unittest.main(verbosity=2)
