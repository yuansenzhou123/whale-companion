"""Conservative experimental Moments publishing through named UIA controls.

Does not import or touch UI Automation until an explicit leased request arrives.
No coordinate guessing, injected calls, privacy-setting changes, or auto retries.
"""
import time


def normalized(text):return str(text or '').replace('\r\n','\n').strip()


class MomentPublisher:
    def __init__(self,ui,get_posts,clock=time.monotonic,sleep=time.sleep):
        self.ui=ui;self.get_posts=get_posts;self.clock=clock;self.sleep=sleep
    def publish(self,text):
        submitted=False
        try:
            before={str(p.get('id') or p.get('tid')) for p in self.get_posts()}
            editor=self.ui.prepare()
            if editor is None:return {'outcome':'draft','error':getattr(self.ui,'preparation_error','') or '未找到可验证的朋友圈编辑入口'}
            if normalized(self.ui.read(editor)):
                return {'outcome':'draft','error':'朋友圈已有未发送正文，没有覆盖'}
            self.ui.fill(editor,text)
            if normalized(self.ui.read(editor))!=normalized(text):
                return {'outcome':'draft','error':'朋友圈正文未能逐字核对，没有点击发表'}
            if hasattr(self.ui,'ready_to_submit') and not self.ui.ready_to_submit(editor):
                return {'outcome':'draft','error':'未找到唯一且可用的发表控件'}
            submitted=True;self.ui.submit(editor)
            deadline=self.clock()+12
            while self.clock()<deadline:
                for post in self.get_posts():
                    identity=str(post.get('id') or post.get('tid'))
                    actual=post.get('text') or post.get('content') or ''
                    if identity not in before and normalized(actual)==normalized(text):return {'outcome':'sent'}
                self.sleep(.8)
            return {'outcome':'unknown','error':'已点击发表，但尚未核对到新动态；不自动重发'}
        except Exception as error:
            reason={'desktop_busy':'当前桌面忙碌，已停止发表操作','action_authorization_changed':'发表授权已改变，已停止操作'}.get(str(error),type(error).__name__)
            return {'outcome':'unknown' if submitted else 'draft','error':reason}
        finally:
            if not submitted:
                try:self.ui.abort()
                except Exception:pass


class WeChatMomentUI:
    def __init__(self,get_driver,paused,authorized=lambda:True,report=None):
        self.get_driver=get_driver;self.paused=paused;self.authorized=authorized;self.pid=None;self.composer=None;self.previous_windows=set()
        self.preparation_error='';self.report=report or (lambda *args:None)
    def fail(self,reason):
        self.preparation_error=reason;self.report('朋友圈入口检查：'+reason);return None
    @staticmethod
    def descendants(root,limit=3500):
        pending=[root];seen=0
        while pending and seen<limit:
            node=pending.pop(0);seen+=1;yield node
            try:pending.extend(node.GetChildren())
            except Exception:pass
    def own_roots(self):
        import uiautomation as automation
        return [w for w in automation.GetRootControl().GetChildren() if getattr(w,'ProcessId',None)==self.pid]
    def available(self):
        if self.paused():raise RuntimeError('desktop_busy')
        if not self.authorized():raise RuntimeError('action_authorization_changed')
    def prepare(self):
        self.preparation_error='';self.available();driver=self.get_driver()
        if driver is None:return self.fail('微信已拉起，但界面自动化驱动不可用')
        # Rebind a stale/minimized window without attempting login or a UI wake fallback.
        ensure=getattr(driver,'ensure_window',None)
        if callable(ensure) and not ensure(wake=False):return self.fail('微信已拉起，但未能重新识别主窗口控件')
        main=getattr(driver,'_win',None)
        if main is None:return self.fail('微信界面驱动没有可用的主窗口')
        self.pid=main.ProcessId
        self.previous_windows={getattr(w,'NativeWindowHandle',0) for w in self.own_roots()}
        # Never take over a pre-existing editor; it may contain the user's draft.
        if self.find_composer():return self.fail('朋友圈已有打开的编辑窗口，没有接管或覆盖')
        buttons=[n for n in self.descendants(main) if getattr(n,'ControlTypeName','')=='ButtonControl' and getattr(n,'Name','')=='朋友圈']
        if len(buttons)!=1:return self.fail('微信已在前台，但未识别到唯一的朋友圈导航按钮（匹配%d个）'%len(buttons))
        buttons[0].Click();time.sleep(.6);self.available()
        roots=self.own_roots();publish=[]
        for root in roots:
            for node in self.descendants(root):
                if getattr(node,'ControlTypeName','')=='ButtonControl' and getattr(node,'Name','') in ('发表朋友圈','发布朋友圈','发布动态','拍照分享','相机'):
                    publish.append(node)
        if len(publish)!=1:return self.fail('已打开朋友圈，但未识别到唯一的发表入口（匹配%d个）'%len(publish))
        publish[0].Click();time.sleep(.6);self.available()
        self.composer=self.find_composer()
        if self.composer is None:return self.fail('已点击朋友圈发表入口，但未识别到编辑窗口')
        editors=[n for n in self.descendants(self.composer,1500) if getattr(n,'ControlTypeName','')=='EditControl']
        if len(editors)!=1:return self.fail('已识别朋友圈编辑窗口，但正文输入框不唯一（匹配%d个）'%len(editors))
        self.report('朋友圈入口检查通过，已找到唯一正文输入框')
        return editors[0]
    def find_composer(self):
        import re
        roots=self.own_roots();matches=[]
        for root in roots:
            for node in self.descendants(root):
                cn=getattr(node,'ClassName','') or '';name=getattr(node,'Name','') or ''
                if re.search(r'SNSPublish|SnsPublish|MomentPublish|PublishMoment|SNSPost',cn) or (name in ('发表朋友圈','发布朋友圈') and getattr(node,'ControlTypeName','') in ('WindowControl','PaneControl')):
                    matches.append(node)
        return matches[0] if len(matches)==1 else None
    def read(self,editor):self.available();return editor.GetValuePattern().Value
    def fill(self,editor,text):self.available();editor.GetValuePattern().SetValue(text)
    def submit(self,editor):
        self.available()
        if self.composer is None:raise RuntimeError('composer_missing')
        buttons=[n for n in self.descendants(self.composer,1500) if getattr(n,'ControlTypeName','')=='ButtonControl' and getattr(n,'Name','') in ('发表','发布','Post')]
        if len(buttons)!=1 or not buttons[0].IsEnabled:raise RuntimeError('publish_button_unverified')
        buttons[0].Click()
    def ready_to_submit(self,editor):
        self.available()
        if self.composer is None:return False
        buttons=[n for n in self.descendants(self.composer,1500) if getattr(n,'ControlTypeName','')=='ButtonControl' and getattr(n,'Name','') in ('发表','发布','Post')]
        return len(buttons)==1 and bool(buttons[0].IsEnabled)
    def abort(self):
        if self.pid is None:return
        # Only dismiss a newly opened file picker. Never close an existing editor
        # or discard a draft, and never press Escape in an unrelated application.
        for window in self.own_roots():
            if getattr(window,'NativeWindowHandle',0) in self.previous_windows:continue
            if getattr(window,'ClassName','')=='#32770' and getattr(window,'Name','') in ('打开','Open'):
                window.GetWindowPattern().Close()
