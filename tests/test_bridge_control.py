import json,os,sys,tempfile,unittest,shutil,subprocess,time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion/desktop'))
from bridge_control import BridgeController


def process(pid,name,args,cwd):
    return SimpleNamespace(pid=pid,name=lambda:name,cmdline=lambda:[name,*args],cwd=lambda:str(cwd),create_time=lambda:1.0)


class BridgeControlTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'project';self.root.mkdir();self.controller=BridgeController(self.root)
    def test_status_uses_live_processes_and_ignores_stale_heartbeat(self):
        data=self.root/'data';data.mkdir();(data/'wechat-bridge-status.json').write_text(json.dumps({'stage':'listening','heartbeatAt':9999999999}))
        with patch('bridge_control.psutil.process_iter',return_value=[]):self.assertFalse(self.controller.status()['running'])
        target=process(123,'python.exe',[str(self.root/'examples/wechatauto_bridge.py')],self.root)
        with patch('bridge_control.psutil.process_iter',return_value=[target]):self.assertTrue(self.controller.status()['running'])
    def test_only_exact_project_script_arguments_match(self):
        own=process(123,'python.exe',['-u','examples/wechatauto_bridge.py'],self.root)
        other=process(124,'python.exe',[str(self.root.parent/'other/examples/wechatauto_bridge.py')],self.root)
        unrelated=process(125,'python.exe',['-c','print("wechatauto_bridge.py")'],self.root)
        wechat=process(126,'WeChat.exe',[],self.root)
        self.assertEqual(self.controller.role(own),'bridge')
        for item in (other,unrelated,wechat):self.assertIsNone(self.controller.role(item))
    def test_guard_scripts_are_identified_without_matching_other_copies(self):
        guard=process(123,'powershell.exe',['-File',str(self.root/'scripts/start-wechat-from-pet.ps1')],self.root)
        batch=process(124,'cmd.exe',['/d','/s','/c','"'+str(self.root/'启动微信桥接.bat')+'"'],self.root)
        other=process(125,'powershell.exe',['-File',str(self.root.parent/'other/scripts/start-wechat-from-pet.ps1')],self.root)
        self.assertEqual(self.controller.role(guard),'guard');self.assertEqual(self.controller.role(batch),'guard');self.assertIsNone(self.controller.role(other))
    def test_stop_marks_only_bridge_and_stops_guards_before_child(self):
        guard=process(124,'powershell.exe',[],self.root);child=process(123,'python.exe',[],self.root);stopped=[]
        def terminate(p,created):
            self.assertTrue(self.controller.marker.exists());stopped.append(p.pid)
        with patch.object(self.controller,'processes',side_effect=[[(child,'bridge',1.),(guard,'guard',1.)],[],[],[]]),patch.object(self.controller,'terminate',side_effect=terminate),patch('bridge_control.time.sleep'):
            result=self.controller.stop()
        self.assertEqual(stopped,[124,123]);self.assertFalse(result['running']);self.assertTrue(self.controller.marker.exists());self.assertFalse((self.root/'data/PAUSED').exists());self.assertEqual(json.loads((self.root/'data/wechat-bridge-status.json').read_text())['stage'],'stopped')
    def test_pid_reuse_is_not_terminated(self):
        original=process(123,'python.exe',[],self.root);replacement=process(123,'python.exe',[],self.root);replacement.create_time=lambda:2.
        with patch('bridge_control.psutil.Process',return_value=replacement),patch('bridge_control.ctypes.WinDLL') as native:
            self.controller.terminate(original,1.)
        native.assert_not_called()

    @unittest.skipUnless(os.name=='nt','Windows PowerShell launcher')
    def test_delayed_start_does_not_override_a_newer_stop(self):
        (self.root/'scripts').mkdir();(self.root/'data').mkdir()
        marker=self.root/'data/WECHAT_STOPPED';marker.write_text('stopped')
        source=Path(__file__).resolve().parents[1]/'scripts/start-wechat-from-pet.ps1'
        helper=self.root/'scripts/start-wechat-from-pet.ps1';shutil.copy2(source,helper)
        (self.root/'启动微信桥接.bat').write_bytes(b'@echo off\r\necho started>unexpected-start.txt\r\nexit /b 0\r\n')
        powershell=Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe'
        result=subprocess.run([str(powershell),'-NoProfile','-ExecutionPolicy','Bypass','-File',str(helper)],cwd=self.root,
            env={**os.environ,'WHALE_BRIDGE_REQUESTED_AT':str(time.time()-60)},capture_output=True,text=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout)['status'],'stopped');self.assertTrue(marker.exists());self.assertFalse((self.root/'unexpected-start.txt').exists())


if __name__=='__main__':unittest.main()
