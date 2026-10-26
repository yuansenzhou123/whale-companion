from pathlib import Path
import sys
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'companion/desktop'))
import pet_instance

class InstanceTests(unittest.TestCase):
    def test_project_copies_do_not_share_a_mutex(self):
        self.assertEqual(pet_instance.mutex_name(ROOT),pet_instance.mutex_name(ROOT/'.'))
        self.assertNotEqual(pet_instance.mutex_name(ROOT),pet_instance.mutex_name(ROOT/'another-copy'))

    def test_offscreen_window_is_clamped_without_moving_an_in_bounds_window(self):
        self.assertEqual(pet_instance.visible_position((100,100,500,700),(0,0,1920,1040)),(100,100))
        self.assertEqual(pet_instance.visible_position((5000,5000,5400,5600),(0,0,1920,1040)),(1512,432))
        self.assertEqual(pet_instance.visible_position((-6000,-100,-5600,500),(-1920,0,0,1040)),(-1912,8))

    def test_live_window_and_exact_python_path_identify_the_instance(self):
        import win32gui,win32process
        own=str(ROOT/'runtime/python/python.exe')
        other=str(ROOT/'another-copy/runtime/python/python.exe')
        def enumerate_windows(callback,context):
            for hwnd in [11,22,33]:callback(hwnd,context)
        with patch.object(win32gui,'EnumWindows',side_effect=enumerate_windows), \
             patch.object(win32gui,'GetClassName',return_value='WhaleGirlNativeLive2D'), \
             patch.object(win32process,'GetWindowThreadProcessId',side_effect=lambda h:(0,h)), \
             patch.object(pet_instance,'process_image',side_effect=lambda p:{11:own,22:other,33:''}[p]):
            self.assertEqual(pet_instance.find_instances(ROOT),[(11,11)])
        # No real window means not running, regardless of an old heartbeat file.
        with patch.object(win32gui,'EnumWindows',return_value=None):
            self.assertEqual(pet_instance.find_instances(ROOT),[])

    def test_reveal_hidden_instance_uses_show_command_without_starting_another_process(self):
        import win32api,win32gui
        visible=False
        messages=[]
        def post(h,msg,*args):
            nonlocal visible
            messages.append(msg)
            if msg==pet_instance.REVEAL_MESSAGE:visible=True
        with patch.object(pet_instance,'find_instances',return_value=[(123,456)]), \
             patch.object(win32gui,'PostMessage',side_effect=post), \
             patch.object(win32gui,'IsWindowVisible',side_effect=lambda h:visible), \
             patch.object(win32gui,'GetWindowRect',return_value=(5000,5000,5400,5600)), \
             patch.object(win32gui,'SetWindowPos') as move, \
             patch.object(win32api,'MonitorFromWindow',return_value=1), \
             patch.object(win32api,'GetMonitorInfo',return_value={'Work':(0,0,1920,1040)}):
            result=pet_instance.reveal_existing(ROOT)
            self.assertEqual(result,{'found':True,'pid':456,'visible':True})
            self.assertEqual(messages,[pet_instance.REVEAL_MESSAGE])
            self.assertEqual(move.call_args.args[2:4],(1512,432))

if __name__=='__main__':unittest.main(verbosity=2)
