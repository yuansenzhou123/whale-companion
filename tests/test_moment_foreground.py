import ast,sys,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'examples'))
from moment_publisher import MomentPublisher,WeChatMomentUI

class ForegroundTests(unittest.TestCase):
    def fixture(self,hwnd=11,foreground=99,activate=False,visible=True,iconic=False):
        tree=ast.parse((ROOT/'examples/wechatauto_bridge.py').read_text(encoding='utf-8-sig'))
        function=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='with_window_on_top')
        state={'foreground':foreground,'active':False};logs=[];calls=[]
        win=SimpleNamespace(IsWindowVisible=lambda h:visible,IsIconic=lambda h:iconic,GetForegroundWindow=lambda:state['foreground'],GetAncestor=lambda h,k:h,GetWindowLong=lambda *args:0,SetWindowPos=lambda *args:None,ShowWindow=lambda *args:None)
        con=SimpleNamespace(SW_SHOW=5,SW_RESTORE=9,GWL_EXSTYLE=-20,WS_EX_TOPMOST=8,HWND_TOPMOST=-1,HWND_NOTOPMOST=-2,SWP_NOMOVE=2,SWP_NOSIZE=1)
        def force(h):
            calls.append(h)
            if activate:state['foreground']=h
            return True  # Simulates an API returning success without giving focus.
        scope={'game_running':lambda:False,'find_weixin_hwnd':lambda:hwnd,'SEND_STATE':state,'time':SimpleNamespace(time=lambda:1,sleep=lambda n:None),'normalize_window':lambda h:None,'force_foreground':force,'log':lambda *args:logs.append(args),'log_window_problem':lambda *args:None}
        exec(compile(ast.Module(body=[function],type_ignores=[]),'<foreground test>','exec'),scope)
        self.addCleanup(mock.patch.stopall);mock.patch.dict(sys.modules,{'win32gui':win,'win32con':con}).start()
        return scope['with_window_on_top'],state,calls,logs
    def test_no_main_window_does_not_start_publisher(self):
        run,state,calls,logs=self.fixture(hwnd=0);publish=mock.Mock();result=run(publish,require_foreground=True)
        self.assertEqual(result['outcome'],'draft');self.assertIn('未找到微信主窗口',result['error']);publish.assert_not_called()
    def test_attempt_without_actual_focus_is_a_foreground_failure(self):
        run,state,calls,logs=self.fixture();publish=mock.Mock();result=run(publish,require_foreground=True)
        self.assertEqual(calls,[11]);self.assertIn('未能把微信恢复并切到前台',result['error']);publish.assert_not_called();self.assertFalse(state['active'])
    def test_successful_activation_runs_publisher_once(self):
        run,state,calls,logs=self.fixture(activate=True);publish=mock.Mock(return_value={'outcome':'draft','error':'ENTRY_STAGE'})
        self.assertEqual(run(publish,require_foreground=True)['error'],'ENTRY_STAGE');publish.assert_called_once();self.assertFalse(state['active'])
    def test_still_hidden_or_minimized_is_not_ready(self):
        for flags in [{'visible':False},{'iconic':True}]:
            run,state,calls,logs=self.fixture(foreground=11,**flags);publish=mock.Mock();self.assertEqual(run(publish,require_foreground=True)['outcome'],'draft');publish.assert_not_called()
    def test_publisher_error_also_resets_active_marker(self):
        run,state,calls,logs=self.fixture(foreground=11)
        with self.assertRaisesRegex(RuntimeError,'test'):run(mock.Mock(side_effect=RuntimeError('test')),require_foreground=True)
        self.assertFalse(state['active'])
    def test_regular_sender_keeps_its_existing_fallback_behavior(self):
        run,state,calls,logs=self.fixture(hwnd=0);publish=mock.Mock(return_value=True);self.assertTrue(run(publish));publish.assert_called_once()

def node(name='',kind='PaneControl',children=()):
    return SimpleNamespace(Name=name,ControlTypeName=kind,ProcessId=123,NativeWindowHandle=456,ClassName='',GetChildren=lambda:list(children),Click=mock.Mock())

class EntryDiagnosticsTests(unittest.TestCase):
    def ui(self,main,roots=(),composer=None):
        driver=SimpleNamespace(_win=main,ensure_window=mock.Mock(return_value=True));clock=[0];ui=WeChatMomentUI(lambda:driver,lambda:False,clock=lambda:clock[0],sleep=lambda seconds:clock.__setitem__(0,clock[0]+seconds))
        ui.own_roots=lambda:list(roots);ui.find_composer=mock.Mock(return_value=composer)
        return ui,driver
    def test_missing_uia_driver_differs_from_a_missing_navigation_button(self):
        ui=WeChatMomentUI(lambda:None,lambda:False);self.assertIsNone(ui.prepare());self.assertIn('驱动不可用',ui.preparation_error)
        ui,driver=self.ui(node());self.assertIsNone(ui.prepare());self.assertIn('朋友圈导航按钮',ui.preparation_error);driver.ensure_window.assert_called_once_with(wake=False)
    def test_existing_editor_is_not_taken_over(self):
        nav=node('朋友圈','ButtonControl');ui,driver=self.ui(node(children=[nav]),composer=node());self.assertIsNone(ui.prepare());self.assertIn('已有打开的编辑窗口',ui.preparation_error);nav.Click.assert_not_called()
    def test_navigation_success_but_no_publish_control_reports_that_stage(self):
        nav=node('朋友圈','ButtonControl');ui,driver=self.ui(node(children=[nav]));self.assertIsNone(ui.prepare());nav.Click.assert_called_once();self.assertIn('已打开朋友圈',ui.preparation_error)
    def test_failure_reason_reaches_result_without_submission(self):
        ui=SimpleNamespace(prepare=lambda:None,preparation_error='微信已在前台，但未识别到朋友圈导航按钮',abort=mock.Mock(),submit=mock.Mock())
        result=MomentPublisher(ui,lambda:[]).publish('SYNTHETIC_BODY');self.assertEqual(result['error'],ui.preparation_error);ui.submit.assert_not_called()

if __name__=='__main__':unittest.main()
