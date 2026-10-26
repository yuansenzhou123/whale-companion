"""Execute only server-leased owner requests, using the existing bridge sender."""
import hashlib
import time


def send_group_ui_once(driver,text,name):
    """Only one exact group result; never fall through to a contact or retry send."""
    if not driver.ensure_window() or not driver.back_to_chat_tab():return False
    box=driver._search_box(driver._win,expand=True)
    if box is None or not driver._set_text(box,name):return False
    results=driver._collect_results(name)
    matches=[r for r in results if r.get('name')==name and r.get('section')=='群聊']
    if len(matches)!=1:return False
    driver._click_ctrl(matches[0]['cell']);time.sleep(.7)
    if driver.current_chat()!=name:return False
    return bool(driver.send_text(text))


def send_group_verified(send,read_messages,text,name,username,me,clock=time.monotonic,sleep=time.sleep):
    def identity(row):return (str(row.get('local_id')),str(row.get('shard')),str(row.get('server_id')))
    before={identity(row) for row in read_messages(username,limit=8)}
    if not send(text,name,username):return False
    deadline=clock()+10
    while clock()<deadline:
        for row in read_messages(username,limit=8):
            if identity(row) in before or row.get('sender_username')!=me or row.get('type')!='文本':continue
            actual=str(row.get('content') or '').strip()
            if actual.startswith(me+':'):actual=actual[len(me)+1:].lstrip()
            if actual==text.strip():return True
        sleep(.4)
    return False


class WeChatActionWorker:
    def __init__(self,base_url,token,http,send,publish_moment,paused,display_name,log,dry_run=False):
        self.base_url=base_url.rstrip('/');self.headers={'X-Bot-Token':token}
        self.http=http;self.send=send;self.publish_moment=publish_moment;self.paused=paused
        self.display_name=display_name;self.log=log;self.dry_run=dry_run;self.pending_ack=None
    def post(self,endpoint,body):
        response=self.http.post(self.base_url+endpoint,json=body,headers=self.headers,timeout=30)
        response.raise_for_status();return response.json()
    def acknowledge(self):
        if not self.pending_ack:return
        result=self.post('/api/actions/ack',self.pending_ack)
        if not result.get('ok'):raise ValueError('action_ack_rejected')
        self.pending_ack=None
        notice=result.get('notification')
        if notice and not self.dry_run and not self.paused():
            try:self.send(notice['text'],self.display_name(notice['chatId']),notice['chatId'])
            except Exception:self.log('任务结果已保存，私聊通知这次未送达')
    def poll_once(self):
        # Network recovery repeats only acknowledgements, never the actual UI action.
        self.acknowledge()
        if self.paused():return False
        result=self.post('/api/actions/next',{})
        job=result.get('job') if result.get('ok') else None
        if not job:return False
        ack={'id':job['id'],'lease':job['lease'],'outcome':'failed','error':''}
        self.pending_ack=ack
        target=job.get('target') or {};text=str(job.get('text') or '')
        valid=bool(text) and hashlib.sha256(text.encode()).hexdigest()==job.get('contentHash')
        valid=valid and self.post('/api/actions/validate',{'id':job['id'],'lease':job['lease']}).get('valid') is True
        if self.paused():valid=False
        if not valid:ack['error']='任务内容、授权或执行状态已改变'
        elif self.dry_run or job.get('dryRun'):
            ack['outcome']='simulated'
        elif job.get('kind')=='group_text':
            username=str(target.get('id') or '')
            if not username.endswith('@chatroom') or not target.get('name'):ack['error']='群聊目标不正确'
            else:
                try:
                    ok=self.send(text,target['name'],username)
                    # GUI send failures may follow a successful keystroke; do not retry.
                    ack['outcome']='sent' if ok else 'unknown'
                    if not ok:ack['error']='微信发送结果未确认'
                except Exception as error:ack.update(outcome='unknown',error=type(error).__name__)
        elif job.get('kind')=='moment_text':
            try:
                answer=self.publish_moment(text) or {}
                ack['outcome']=answer.get('outcome','unknown');ack['error']=str(answer.get('error') or '')[:240]
            except Exception as error:ack.update(outcome='unknown',error=type(error).__name__)
        else:ack['error']='未支持的任务类型'
        self.acknowledge();return True
    def run(self):
        import uiautomation as automation
        automation.InitializeUIAutomationInCurrentThread()
        while True:
            time.sleep(3)
            try:self.poll_once()
            except Exception as error:self.log('动作任务本轮未完成：',type(error).__name__)
