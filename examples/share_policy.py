"""Auto-video recipient policy, reloaded before selection and delivery."""
import json
import math
import random
import re

def chat_id(value):
    return isinstance(value,str) and len(value)<=160 and bool(re.fullmatch(r'[A-Za-z0-9_-]+(?:@chatroom)?',value)) and value not in {'filehelper','weixin'} and not value.startswith('gh_')

def load_policy(path):
    disabled={'enabled':False,'everyMinutes':120.0,'allowedChats':set()}
    try:
        with open(path,'r',encoding='utf-8-sig') as f:share=json.load(f).get('share',{})
        entries=share.get('allowedChats',[])
        if not isinstance(entries,list) or len(entries)>200 or any(not chat_id(x) for x in entries):return disabled
        interval=float(share.get('everyMinutes',120))
        if not math.isfinite(interval) or not 1<=interval<=10080:return disabled
        return {'enabled':share.get('enabled') is True,'everyMinutes':interval,'allowedChats':set(entries)}
    except (OSError,ValueError,TypeError,AttributeError):return disabled

def choose_target(candidates,policy,choose=random.choice):
    if not policy['enabled']:return None
    eligible=list({uid:(uid,name) for uid,name in candidates if chat_id(uid) and uid in policy['allowedChats']}.values())
    return choose(eligible) if eligible else None

def send_if_allowed(path,uid,name,text,send,paused=lambda:False):
    policy=load_policy(path)
    if not policy['enabled'] or uid not in policy['allowedChats'] or not chat_id(uid) or paused():return False
    # Sharing must never enter the ordinary reply queue and outlive an allowlist removal.
    return bool(send(text,name,uid,queue_if_busy=False))
