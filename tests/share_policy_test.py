import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'examples'))
from share_policy import load_policy,choose_target,send_if_allowed

class SharePolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='whale-share-policy-');self.path=Path(self.temp.name)/'config.json'
    def tearDown(self):self.temp.cleanup()
    def write(self,ids=None,enabled=True):
        self.path.write_text(json.dumps({'share':{'enabled':enabled,'everyMinutes':120,'allowedChats':ids if ids is not None else []}}),encoding='utf-8-sig')
    def test_missing_empty_invalid_or_unreadable_policies_never_choose_a_recipient(self):
        for raw in [None,'broken','{}',json.dumps({'share':{'enabled':True,'allowedChats':'wxid_one'}}),json.dumps({'share':{'enabled':True,'allowedChats':['*']}})]:
            if raw is not None:self.path.write_text(raw,encoding='utf-8')
            self.assertIsNone(choose_target([('wxid_one','同名')],load_policy(self.path)))
        self.write();self.assertIsNone(choose_target([('wxid_one','同名')],load_policy(self.path)))
    def test_filters_before_random_selection_and_never_matches_a_display_name(self):
        self.write(['wxid_one','123@chatroom']);choose=Mock(side_effect=lambda rows:rows[-1])
        out=choose_target([('wxid_other','wxid_one'),('wxid_one','同名'),('123@chatroom','群聊'),('filehelper','助手'),('wxid_one','同名')],load_policy(self.path),choose)
        self.assertEqual(out,('123@chatroom','群聊'));self.assertEqual(len(choose.call_args.args[0]),2)
        self.assertNotIn('wxid_other',{row[0] for row in choose.call_args.args[0]})
    def test_unknown_allowed_recipient_does_not_fall_back_to_another_chat(self):
        self.write(['wxid_not_active']);self.assertIsNone(choose_target([('wxid_other','其他人')],load_policy(self.path)))
    def test_removed_during_generation_is_checked_again_before_sending(self):
        self.write(['wxid_one']);self.assertIsNotNone(choose_target([('wxid_one','名字')],load_policy(self.path)))
        self.write([]);send=Mock();self.assertFalse(send_if_allowed(self.path,'wxid_one','名字','link',send));send.assert_not_called()
    def test_disabled_paused_or_invalid_config_blocks_delivery(self):
        self.write(['wxid_one']);send=Mock();self.assertFalse(send_if_allowed(self.path,'wxid_one','名字','link',send,paused=lambda:True))
        self.write(['wxid_one'],False);self.assertFalse(send_if_allowed(self.path,'wxid_one','名字','link',send))
        self.path.write_text('{');self.assertFalse(send_if_allowed(self.path,'wxid_one','名字','link',send));send.assert_not_called()
    def test_allowed_delivery_never_enters_ordinary_reply_queue(self):
        self.write(['wxid_one']);send=Mock(return_value=True)
        self.assertTrue(send_if_allowed(self.path,'wxid_one','名字','link',send));send.assert_called_once_with('link','名字','wxid_one',queue_if_busy=False)
    def test_live_reload_detects_replaced_list_and_interval(self):
        self.write(['wxid_one']);self.assertEqual(load_policy(self.path)['allowedChats'],{'wxid_one'})
        self.path.write_text(json.dumps({'share':{'enabled':True,'allowedChats':['123@chatroom'],'everyMinutes':5}}))
        p=load_policy(self.path);self.assertEqual(p['allowedChats'],{'123@chatroom'});self.assertEqual(p['everyMinutes'],5)
    def test_bridge_module_loads_with_bundled_python_from_an_unrelated_directory(self):
        import shutil, subprocess
        original=Path(__file__).resolve().parents[1]/'examples'
        scripts=Path(self.temp.name)/'examples';scripts.mkdir()
        for name in ['wechatauto_bridge.py','share_policy.py']:shutil.copy2(original/name,scripts/name)
        code='import runpy; runpy.run_path('+repr(str(scripts/'wechatauto_bridge.py'))+',run_name="bridge_import_check"); print("safe-import-ok")'
        result=subprocess.run([sys.executable,'-c',code],cwd=self.temp.name,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('safe-import-ok',result.stdout)

    def test_special_accounts_and_nonfinite_intervals_are_rejected(self):
        for uid in ['filehelper','weixin','gh_service','群聊名字','wxid_one\nwxid_other','*']:
            self.write([uid]);self.assertFalse(load_policy(self.path)['enabled'])
        for interval in [0,-2,float('nan'),float('inf')]:
            self.path.write_text(json.dumps({'share':{'enabled':True,'allowedChats':['wxid_one'],'everyMinutes':interval}}))
            self.assertFalse(load_policy(self.path)['enabled'])

if __name__=='__main__':unittest.main(verbosity=2)
