import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'companion/desktop'))
from live2d_pet import Pet, presentation, launch_wechat_bridge, request_wechat_bridge
from live2d_renderer import EMOTION_EXPRESSIONS, DEFAULT_MODEL
from pet_controls import VisualCatalog, VisualControls

class PetTests(unittest.TestCase):
    def test_supplied_mouse_model_and_textures_are_unchanged(self):
        modeldir = DEFAULT_MODEL.parent
        config = json.loads(DEFAULT_MODEL.read_text(encoding='utf-8'))
        with zipfile.ZipFile(ROOT/'live2D/DS鼠控版.zip') as source:
            refs = config['FileReferences']
            for name in [refs['Moc'],refs['Physics'],*refs['Textures']]:
                self.assertEqual((modeldir/name).read_bytes(),source.read(name))
        expressions = {row['Name']:row['File'] for row in refs['Expressions']}
        self.assertEqual(len(expressions),44)
        for mood, name in EMOTION_EXPRESSIONS.items():
            if name:
                self.assertIn(name,expressions,mood)
                path = (modeldir/expressions[name]).resolve()
                self.assertTrue(path.is_relative_to(modeldir.resolve()))
                self.assertIn('Parameters',json.loads(path.read_text(encoding='utf-8')))

    def test_model_uses_current_emotion_and_comments_expire(self):
        state = {'status':'watching','expression':'happy','video':{'title':'一起看猫猫'},'comment':'这只猫装得好无辜','commentAt':100000}
        mood,title,bubble,talking = presentation(state,102000)
        self.assertEqual(mood,'happy')
        self.assertEqual(title,'一起看猫猫')
        self.assertEqual(bubble,state['comment'])
        self.assertTrue(talking)
        self.assertFalse(presentation(state,110000)[3])
        self.assertNotEqual(presentation(state,141000)[2],state['comment'])
        paused = {**state,'status':'paused','expression':'sleepy','comment':''}
        self.assertIn('右键',presentation(paused,141000)[2])
        self.assertEqual(presentation(None,141000)[0],'sleepy')

    def test_date_bubbles_and_quiet_company_do_not_require_a_video(self):
        scene = {'kind':'chat','label':'饭后聊聊','phase':'opening','bubble':{'text':'来，借我十五分钟～','at':100000,'emotion':'happy'}}
        state = {'status':'disconnected','dateScene':scene}
        self.assertEqual(presentation(state,102000)[:3],('happy','饭后聊聊','来，借我十五分钟～'))
        self.assertNotIn('等你放视频',presentation(state,141000)[2])
        scene.update(kind='quiet',label='安静陪一会儿',bubble=None)
        self.assertEqual(presentation(state,141000)[0],'sleepy')
        self.assertIn('你忙你的',presentation(state,141000)[2])
        state['status']='paused'
        state['paused']=False  # Disabling video capture must not hide a text date.
        self.assertIn('你忙你的',presentation(state,141000)[2])
        state['paused']=True
        self.assertIn('右键',presentation(state,141000)[2])

    def make_menu(self, selected):
        import win32con
        pet = Pet.__new__(Pet)
        pet.con = win32con
        pet.gui = Mock()
        pet.gui.CreatePopupMenu.side_effect = [11,12,13,14,15]
        pet.renderer = Mock(catalog=VisualCatalog(DEFAULT_MODEL))
        pet.controls = VisualControls(pet.renderer.catalog)
        pet.gui.GetForegroundWindow.side_effect = [456,123]
        pet.gui.TrackPopupMenu.return_value = selected
        pet.gui.IsWindow.return_value = True
        pet.api = Mock()
        pet.api.GetCursorPos.return_value = (10,20)
        pet.hwnd = 123
        pet.visible = True
        pet.endpoint = 'http://127.0.0.1:8787'
        pet.bridge_controller=Mock()
        pet.bridge_controller.status.return_value={'running':False}
        pet.bridge_busy=False
        pet.backend = Mock(state={'settings':{'enabled':True,'automaticComments':True}})
        return pet

    def test_native_right_click_actions_use_existing_service_and_restore_player_focus(self):
        for selected,route,body in [(1,'settings',{'enabled':False}),(2,'comment',{}),(3,'settings',{'automaticComments':False})]:
            with self.subTest(selected=selected):
                pet = self.make_menu(selected)
                pet.menu()
                pet.backend.post.assert_called_once_with(route,body)
                pet.gui.SetForegroundWindow.assert_called_with(456)
                pet.gui.DestroyMenu.assert_called_once_with(11)

    def test_persona_shortcut_opens_the_shared_page_and_bridge_shortcut_uses_guard(self):
        pet=self.make_menu(10)
        with patch('live2d_pet.webbrowser.open') as opened:
            pet.menu()
            opened.assert_called_once_with('http://127.0.0.1:8787/persona')
        pet=self.make_menu(11)
        with patch('live2d_pet.webbrowser.open') as opened:
            pet.menu()
            opened.assert_called_once_with('http://127.0.0.1:8787/debug#cfg_share')
        pet=self.make_menu(9)
        with patch.object(pet,'request_bridge_toggle') as request:
            pet.menu()
            request.assert_called_once_with(True)
        pet.backend.post.assert_not_called()

    def test_bridge_notice_distinguishes_existing_process_and_start_request(self):
        for status,expected,starts in [('alreadyRunning','正在监听',False),('ready','正在启动',True)]:
            with self.subTest(status=status), patch('subprocess.run',return_value=Mock(stdout=json.dumps({'status':status}))) as query, patch('pathlib.Path.read_text',return_value=json.dumps({'stage':'listening','heartbeatAt':__import__('time').time()})), patch('live2d_pet.launch_wechat_bridge') as launch:
                text=request_wechat_bridge()
                self.assertIn(expected,text)
                self.assertNotIn('登录',text)
                self.assertEqual(launch.called,starts)
                self.assertEqual(query.call_args.args[0][-1],'-CheckOnly')
        with patch('subprocess.run',return_value=Mock(stdout='broken')),patch('live2d_pet.launch_wechat_bridge') as launch:
            with self.assertRaises(ValueError):request_wechat_bridge()
            launch.assert_not_called()

    def test_bridge_launcher_uses_hidden_child_with_safe_separate_arguments(self):
        import subprocess
        with patch('subprocess.Popen') as launch:
            launch_wechat_bridge()
            args,options=launch.call_args
            self.assertTrue(args[0][0].lower().endswith('powershell.exe'))
            self.assertEqual(args[0][-1],str(ROOT/'scripts/start-wechat-from-pet.ps1'))
            self.assertEqual(options['cwd'],str(ROOT))
            self.assertEqual(options['creationflags'],subprocess.CREATE_NO_WINDOW)
            self.assertNotIn('shell',options)

    def test_real_windows_menu_handles_and_separator_accept_all_items(self):
        import win32gui
        pet = self.make_menu(0)
        pet.gui = win32gui
        with patch.object(win32gui,'TrackPopupMenu',return_value=0), \
             patch.object(win32gui,'PostMessage'), \
             patch.object(win32gui,'SetForegroundWindow'), \
             patch.object(win32gui,'GetForegroundWindow',return_value=123):
            pet.menu()
        pet.backend.post.assert_not_called()

    def test_bridge_menu_checkmark_tracks_real_state_and_click_sets_requested_state(self):
        import win32con
        for running in (False,True):
            pet=self.make_menu(9);pet.bridge_controller.status.return_value={'running':running}
            with patch.object(pet,'request_bridge_toggle') as request:pet.menu()
            row=next(call.args for call in pet.gui.AppendMenu.call_args_list if call.args[2]==9)
            self.assertEqual(bool(row[1]&win32con.MF_CHECKED),running)
            self.assertEqual(row[3],'微信桥接');request.assert_called_once_with(not running)

    def test_bridge_busy_is_disabled_and_repeated_click_does_not_spawn_more_work(self):
        import win32con
        pet=self.make_menu(0);pet.bridge_busy=True;pet.menu()
        row=next(call.args for call in pet.gui.AppendMenu.call_args_list if call.args[2]==9)
        self.assertTrue(row[1]&win32con.MF_GRAYED)
        with patch('live2d_pet.threading.Thread') as thread:pet.request_bridge_toggle(False)
        thread.assert_not_called()

    def test_turning_bridge_off_uses_controller_and_keeps_pet_backend_running(self):
        pet=self.make_menu(0)
        with patch('live2d_pet.threading.Thread') as thread,patch('live2d_pet.request_wechat_bridge') as start:
            pet.request_bridge_toggle(False);self.assertTrue(pet.bridge_busy)
            thread.call_args.kwargs['target']()
        pet.bridge_controller.stop.assert_called_once_with();start.assert_not_called();pet.backend.post.assert_not_called();self.assertFalse(pet.bridge_busy)

    def test_expression_preview_is_local_and_does_not_send_messages(self):
        catalog = VisualCatalog(DEFAULT_MODEL)
        pet = self.make_menu(1001+catalog.faces.index('脸红'))
        pet.menu()
        self.assertEqual(pet.controls.manual_face,'脸红')
        pet.backend.post.assert_not_called()

if __name__ == '__main__':
    unittest.main(verbosity=2)
