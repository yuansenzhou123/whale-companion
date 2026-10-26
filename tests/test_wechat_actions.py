import hashlib,os,sys,unittest
from types import SimpleNamespace
sys.path.insert(0,os.path.join(os.getcwd(),'examples'))
from wechat_action_worker import WeChatActionWorker,send_group_verified,send_group_ui_once
from moment_publisher import MomentPublisher


class WorkerTests(unittest.TestCase):
    def fixture(self,dry=False):
        sent=[];calls=[];self.ack_fail=False
        job={'id':'j','lease':'lease','kind':'group_text','text':'BODY','target':{'id':'123@chatroom','name':'测试群'},'contentHash':hashlib.sha256(b'BODY').hexdigest()}
        state={'served':False}
        def post(url,**kw):
            calls.append(url)
            if url.endswith('/next'):
                result={'ok':True,'job':None if state['served'] else job};state['served']=True
            elif url.endswith('/validate'):result={'ok':True,'valid':True}
            else:
                if self.ack_fail:self.ack_fail=False;raise OSError('lost ack')
                result={'ok':True}
            return SimpleNamespace(raise_for_status=lambda:None,json=lambda:result)
        worker=WeChatActionWorker('http://local','token',SimpleNamespace(post=post),lambda *args:sent.append(args) or True,lambda text:{'outcome':'draft'},lambda:False,lambda s:s,lambda *a:None,dry_run=dry)
        return worker,sent,calls,job
    def test_lost_ack_only_retries_ack_not_message(self):
        worker,sent,calls,job=self.fixture();self.ack_fail=True
        with self.assertRaises(OSError):worker.poll_once()
        self.assertEqual(len(sent),1);worker.poll_once();self.assertEqual(len(sent),1)
    def test_dry_run_never_invokes_sender(self):
        worker,sent,calls,job=self.fixture(dry=True);worker.poll_once();self.assertEqual(sent,[])
    def test_hash_mismatch_never_invokes_sender(self):
        worker,sent,calls,job=self.fixture();job['text']='CHANGED';worker.poll_once();self.assertEqual(sent,[])
    def test_existing_identical_message_is_not_new_delivery_evidence(self):
        now=[0];old={'local_id':1,'shard':'db','type':'文本','sender_username':'me','content':'BODY'}
        good=send_group_verified(lambda *a:True,lambda *a,**k:[old],'BODY','群','123@chatroom','me',clock=lambda:now[0],sleep=lambda n:now.__setitem__(0,now[0]+n))
        self.assertFalse(good)
    def test_new_matching_target_message_confirms_delivery(self):
        rows=[]
        def send(*args):rows.append({'local_id':2,'shard':'db','type':'文本','sender_username':'me','content':'BODY'});return True
        self.assertTrue(send_group_verified(send,lambda *a,**k:rows.copy(),'BODY','群','123@chatroom','me'))


class MomentTests(unittest.TestCase):
    def fixture(self,existing='',verify=True,mismatch=False):
        state={'text':existing,'submitted':False,'time':0,'aborted':False}
        ui=SimpleNamespace(prepare=lambda:'editor',read=lambda e:state['text'],fill=lambda e,t:state.update(text='mismatch' if mismatch else t),submit=lambda e:state.update(submitted=True),abort=lambda:state.update(aborted=True))
        posts=lambda:[{'tid':2,'text':'BODY'}] if state['submitted'] and verify else []
        publisher=MomentPublisher(ui,posts,clock=lambda:state['time'],sleep=lambda n:state.update(time=state['time']+n))
        return publisher,state
    def test_existing_draft_is_not_overwritten(self):
        publisher,state=self.fixture(existing='USER_DRAFT');self.assertEqual(publisher.publish('BODY')['outcome'],'draft');self.assertFalse(state['submitted']);self.assertEqual(state['text'],'USER_DRAFT')
    def test_content_must_match_before_submit(self):
        publisher,state=self.fixture(mismatch=True);self.assertEqual(publisher.publish('BODY')['outcome'],'draft');self.assertFalse(state['submitted'])
    def test_only_new_verified_post_counts_as_sent(self):
        publisher,state=self.fixture();self.assertEqual(publisher.publish('BODY')['outcome'],'sent')
        publisher,state=self.fixture(verify=False);self.assertEqual(publisher.publish('BODY')['outcome'],'unknown');self.assertTrue(state['submitted'])



class GroupTargetTests(unittest.TestCase):
    def driver(self,results):
        sent=[]
        driver=SimpleNamespace(_win='window',ensure_window=lambda:True,back_to_chat_tab=lambda:True,
            _search_box=lambda *a,**k:'search',_set_text=lambda *a:True,_collect_results=lambda name:results,
            _click_ctrl=lambda cell:None,current_chat=lambda:'GROUP',send_text=lambda text:sent.append(text) or True)
        return driver,sent
    def test_contact_or_fuzzy_group_results_are_rejected(self):
        for results in [[{'name':'GROUP','section':'联系人','cell':'contact'}],[{'name':'GROUP-other','section':'群聊','cell':'other'}]]:
            driver,sent=self.driver(results);self.assertFalse(send_group_ui_once(driver,'BODY','GROUP'));self.assertEqual(sent,[])
    def test_duplicate_group_results_are_rejected(self):
        driver,sent=self.driver([{'name':'GROUP','section':'群聊','cell':'one'},{'name':'GROUP','section':'群聊','cell':'two'}])
        self.assertFalse(send_group_ui_once(driver,'BODY','GROUP'));self.assertEqual(sent,[])
    def test_unique_exact_group_sends_only_once(self):
        driver,sent=self.driver([{'name':'GROUP','section':'群聊','cell':'one'}]);self.assertTrue(send_group_ui_once(driver,'BODY','GROUP'));self.assertEqual(sent,['BODY'])
    def test_client_username_tid_is_not_a_post_identity(self):
        state={'submitted':False,'text':'','time':0}
        ui=SimpleNamespace(prepare=lambda:'edit',read=lambda e:state['text'],fill=lambda e,t:state.update(text=t),submit=lambda e:state.update(submitted=True),abort=lambda:None)
        posts=lambda:[{'id':'new' if state['submitted'] else 'old','tid':'wxid_self','text':'BODY'}]
        publisher=MomentPublisher(ui,posts,clock=lambda:state['time'],sleep=lambda n:state.update(time=state['time']+n))
        self.assertEqual(publisher.publish('BODY')['outcome'],'sent')

if __name__=='__main__':unittest.main()
