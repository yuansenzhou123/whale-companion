from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'examples'))
from bridge_health import ReceiveHealth

class ReceiveHealthTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='whale-receive-health-');self.path=Path(self.temp.name)/'status.json';self.now=1000.;self.client=(10.,123);self.restart=Mock();self.report=Mock()
        self.h=ReceiveHealth(self.path,'wxid_test',clock=lambda:self.now,generation=lambda:self.client,restart=self.restart,report=self.report)
    def tearDown(self):self.h.close();self.temp.cleanup()
    def test_healthy_receive_loop_updates_real_heartbeat_without_message_content(self):
        self.h.poll_begin();self.now+=1;self.h.poll_ok();self.h.incoming();self.h.observe('收到','private-name','secret message');self.h.check_once()
        raw=self.path.read_text();state=json.loads(raw);self.assertEqual(state['stage'],'listening');self.assertEqual(state['pollCount'],1);self.assertEqual(state['incomingCount'],1);self.assertNotIn('secret message',raw);self.assertNotIn('private-name',raw);self.assertNotIn('wxid_test',raw);self.restart.assert_not_called()
    def test_wechat_restart_recovers_only_once(self):
        self.h.poll_ok();self.client=(20.,456);self.h.check_once();self.h.check_once();self.restart.assert_called_once();self.assertEqual(self.h.data['problem'],'wechat_restarted')
    def test_client_closed_waits_without_restart_storm_then_reconnects_on_open(self):
        self.client=None;self.now+=1000;self.h.check_once();self.restart.assert_not_called();self.assertEqual(self.h.data['stage'],'waiting_for_wechat');self.client=(30.,789);self.h.check_once();self.restart.assert_called_once()
    def test_stuck_poll_and_repeated_failures_trigger_bounded_recovery(self):
        self.h.poll_begin();self.now+=91;self.h.check_once();self.restart.assert_called_once();self.assertEqual(self.h.data['problem'],'receive_poll_stalled')
    def test_repeated_database_errors_are_not_reported_as_listening(self):
        for i in range(5):self.h.poll_failed(RuntimeError('private exception text'))
        self.now+=31;self.h.check_once();self.restart.assert_called_once();self.assertNotIn('private exception text',self.path.read_text())
    def test_normal_short_poll_and_single_database_error_do_not_restart(self):
        self.h.poll_begin();self.now+=10;self.h.check_once();self.h.poll_failed(RuntimeError());self.h.check_once();self.restart.assert_not_called()
    def test_backend_and_send_status_are_distinct(self):
        self.h.observe('请求鲸鲸失败：',RuntimeError());self.assertEqual(self.h.data['problem'],'backend_unavailable');self.h.observe('发送成功（1.2s）→ friend');self.assertEqual(self.h.data['lastSendAt'],self.now);self.assertEqual(self.h.data['problem'],'')

if __name__=='__main__':unittest.main(verbosity=2)
