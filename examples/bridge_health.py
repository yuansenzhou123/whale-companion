"""Receive-loop heartbeat and recovery without storing message text or account IDs."""
import hashlib
import json
import os
from pathlib import Path
import threading
import time

def wechat_generation():
    import psutil
    candidates=[]
    for p in psutil.process_iter(['pid','name','create_time']):
        try:
            if str(p.info['name']).lower()=='weixin.exe':candidates.append((p.info['create_time'],p.info['pid']))
        except (psutil.Error,KeyError):pass
    return min(candidates) if candidates else None

class ReceiveHealth:
    def __init__(self,path,account,report=print,restart=lambda:os._exit(2),clock=time.time,generation=wechat_generation):
        self.path=Path(path);self.report=report;self.restart=restart;self.clock=clock;self.generation=generation
        self.initial_client=generation();self.started=clock();self.stop=threading.Event();self.lock=threading.RLock();self.listener=None;self.recovering=False
        self.data={'version':1,'pid':os.getpid(),'accountHash':hashlib.sha256(account.encode()).hexdigest()[:10],'stage':'connecting','heartbeatAt':clock(),'lastPollAt':0,'pollStartedAt':0,'pollCount':0,'incomingCount':0,'lastIncomingAt':0,'lastForwardAt':0,'lastSendAt':0,'pollErrors':0,'problem':''}
        self.persist()
    def persist(self):
        try:
            with self.lock:
                self.data['heartbeatAt']=self.clock();self.path.parent.mkdir(parents=True,exist_ok=True)
                tmp=self.path.with_name(self.path.name+'.'+str(os.getpid())+'.tmp');tmp.write_text(json.dumps(self.data),encoding='utf-8');tmp.replace(self.path)
        except OSError:pass
    def poll_begin(self):
        with self.lock:self.data['pollStartedAt']=self.clock()
    def poll_ok(self):
        with self.lock:self.data.update(stage='listening',lastPollAt=self.clock(),pollStartedAt=0,pollCount=self.data['pollCount']+1,pollErrors=0,problem='')
    def poll_failed(self,error):
        with self.lock:self.data.update(pollStartedAt=0,pollErrors=self.data['pollErrors']+1,problem='database_'+type(error).__name__)
    def incoming(self):
        with self.lock:self.data.update(lastIncomingAt=self.clock(),incomingCount=self.data['incomingCount']+1)
    def observe(self,*args):
        if not args:return
        tag=str(args[0])
        with self.lock:
            if tag=='收到':self.data['lastForwardAt']=self.clock()
            elif tag.startswith('发送成功'):self.data.update(lastSendAt=self.clock(),problem='')
            elif tag=='请求鲸鲸失败：':self.data['problem']='backend_unavailable'
            elif tag.startswith('发送通道预热失败'):self.data['problem']='wechat_window_unavailable'
    def recover(self,reason):
        if self.recovering:return
        self.recovering=True
        with self.lock:self.data.update(stage='reconnecting',problem=reason)
        self.persist();self.report('接收监听需要重新连接：'+reason+'；将自动重新建立微信连接。');self.restart()
    def check_once(self):
        if self.stop.is_set() or self.recovering:return
        current=self.generation();now=self.clock()
        if current is None:
            with self.lock:self.data['stage']='waiting_for_wechat'
            self.persist();return
        if current!=self.initial_client:self.recover('wechat_restarted');return
        with self.lock:d=dict(self.data)
        if d['pollStartedAt'] and now-d['pollStartedAt']>90:self.recover('receive_poll_stalled');return
        if d['pollErrors']>=5 and now-(d['lastPollAt'] or self.started)>30:self.recover('receive_poll_failed');return
        if self.listener is not None and self.listener._thread is not None and not self.listener._thread.is_alive() and now-self.started>10:self.recover('receive_thread_stopped');return
        if not d['lastPollAt'] and now-self.started>120:self.recover('receive_startup_stalled');return
        self.persist()
    def start(self):
        def run():
            while not self.stop.wait(5):
                try:self.check_once()
                except Exception:pass
        threading.Thread(target=run,name='wechat-receive-health',daemon=True).start()
    def close(self):
        self.stop.set()
        with self.lock:self.data['stage']='stopped'
        self.persist()
