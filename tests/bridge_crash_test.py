import ast
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


class CrashDiagnosticsTest(unittest.TestCase):
    def load_configure(self):
        tree = ast.parse((ROOT / 'examples' / 'wechatauto_bridge.py').read_text(encoding='utf-8-sig'))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'configure_crash_log')
        scope = {'os': os}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<bridge diagnostics>', 'exec'), scope)
        return scope['configure_crash_log']

    def test_default_never_schedules_periodic_thread_dump(self):
        fake = types.SimpleNamespace(enable=mock.Mock(), dump_traceback_later=mock.Mock())
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(sys.modules, {'faulthandler': fake}), mock.patch.dict(os.environ, {}, clear=True):
            handle = self.load_configure()(directory, mock.Mock())
            try:
                fake.enable.assert_called_once_with(file=handle, all_threads=False)
                fake.dump_traceback_later.assert_not_called()
                self.assertFalse(handle.closed)
            finally:
                handle.close()

    def test_periodic_thread_dump_requires_explicit_debug_flag(self):
        fake = types.SimpleNamespace(enable=mock.Mock(), dump_traceback_later=mock.Mock())
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(sys.modules, {'faulthandler': fake}), mock.patch.dict(os.environ, {'WHALE_TRACE_HANGS': '1'}, clear=True):
            handle = self.load_configure()(directory, mock.Mock())
            try:
                fake.dump_traceback_later.assert_called_once_with(40, repeat=True, file=handle)
            finally:
                handle.close()


@unittest.skipUnless(os.name == 'nt', 'Windows launcher behavior')
class LauncherRecoveryTest(unittest.TestCase):
    def run_scenario(self, scenario):
        with tempfile.TemporaryDirectory(prefix='whale-crash-launcher-') as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            text = (ROOT / '启动微信桥接.bat').read_text(encoding='utf-8-sig')
            text = text.replace('set "PY=%~dp0runtime\\python\\python.exe"', 'set "PY=' + sys.executable + '"')
            text = text.replace('"%PY%" -u "%~dp0examples\\wechatauto_bridge.py"', 'call "%~dp0fake-child.bat"')
            text = text.replace('timeout /t %RETRY_SECONDS% /nobreak >nul', 'rem test delay suppressed')
            text = text.replace('pause >nul', 'rem test pause suppressed')
            launcher = root / 'launcher.bat'
            launcher.write_bytes(text.replace('\n', '\r\n').encode('utf-8'))
            fake = '''@echo off
set /a TEST_RUNS+=1 >nul
echo SIMULATED_CHILD_%TEST_RUNS%
if "%TEST_SCENARIO%"=="fatal" exit /b -1073741819
if "%TEST_SCENARIO%"=="watchdog" exit /b 2
if "%TEST_SCENARIO%"=="interrupt" exit /b -1073741510
if "%TEST_SCENARIO%"=="recover" if %TEST_RUNS% EQU 1 exit /b -1073741819
if "%TEST_SCENARIO%"=="bridge_stopped" (
  type nul >data\\WECHAT_STOPPED
  exit /b 2
)
if "%TEST_SCENARIO%"=="paused" (
  type nul >data\\PAUSED
  exit /b 2
)
exit /b 0
'''
            (root / 'fake-child.bat').write_bytes(fake.replace('\n', '\r\n').encode('utf-8'))
            env = {**os.environ, 'TEST_SCENARIO': scenario, 'TEST_RUNS': '0'}
            result = subprocess.run([os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/c', str(launcher)], cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
            output = result.stdout.decode('utf-8', errors='replace')
            return result.returncode, output.count('SIMULATED_CHILD_'), output

    def test_native_crash_recovers_then_normal_exit_stops(self):
        code, count, _ = self.run_scenario('recover')
        self.assertEqual(code, 0)
        self.assertEqual(count, 2)

    def test_repeated_native_crash_stops_after_three_retries(self):
        code, count, output = self.run_scenario('fatal')
        self.assertNotEqual(code, 0)
        self.assertEqual(count, 4)
        self.assertIn('Automatic recovery limit reached', output)

    def test_watchdog_restart_is_also_bounded(self):
        code, count, _ = self.run_scenario('watchdog')
        self.assertEqual(code, 2)
        self.assertEqual(count, 4)

    def test_normal_exit_does_not_restart(self):
        code, count, _ = self.run_scenario('normal')
        self.assertEqual((code, count), (0, 1))

    def test_user_interrupt_does_not_restart(self):
        code, count, _ = self.run_scenario('interrupt')
        self.assertNotEqual(code, 0)
        self.assertEqual(count, 1)

    def test_bridge_only_stop_marker_blocks_crash_recovery(self):
        code,count,output=self.run_scenario('bridge_stopped')
        self.assertEqual((code,count),(0,1));self.assertIn('Automatic recovery stopped',output)

    def test_pause_marker_prevents_restart(self):
        code, count, output = self.run_scenario('paused')
        self.assertEqual((code, count), (0, 1))
        self.assertIn('Automatic recovery stopped', output)


if __name__ == '__main__':
    unittest.main()
