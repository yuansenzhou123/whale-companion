"""Moments publishing through scoped UIA controls, with verified approved image input.

Discover -> Moments -> camera -> native file picker -> caption -> publish.
No global coordinate clicks, privacy-setting changes, or automatic retries.
"""
import hashlib,pathlib,re,time

def normalized(text):return str(text or '').replace('\r\n','\n').strip()

class MomentPublisher:
    def __init__(self,ui,get_posts,clock=time.monotonic,sleep=time.sleep):
        self.ui=ui;self.get_posts=get_posts;self.clock=clock;self.sleep=sleep
    def publish(self,text,image_path=None):
        submitted=False
        try:
            before={str(p.get('id') or p.get('tid')) for p in self.get_posts()}
            editor=self.ui.prepare(image_path=image_path) if image_path else self.ui.prepare()
            if editor is None:return {'outcome':'draft','error':getattr(self.ui,'preparation_error','') or '未找到可验证的朋友圈编辑入口'}
            if normalized(self.ui.read(editor)):return {'outcome':'draft','error':'朋友圈已有未发送正文，没有覆盖'}
            self.ui.fill(editor,text)
            if normalized(self.ui.read(editor))!=normalized(text):return {'outcome':'draft','error':'朋友圈正文未能逐字核对，没有点击发表'}
            if hasattr(self.ui,'ready_to_submit') and not self.ui.ready_to_submit(editor):return {'outcome':'draft','error':'发表控件或所选配图未能通过核对，没有点击发表'}
            submitted=True;self.ui.submit(editor)
            deadline=self.clock()+12
            while self.clock()<deadline:
                for post in self.get_posts():
                    identity=str(post.get('id') or post.get('tid'));actual=post.get('text') or post.get('content') or ''
                    if identity not in before and normalized(actual)==normalized(text) and (not image_path or bool(post.get('images'))):return {'outcome':'sent'}
                self.sleep(.8)
            return {'outcome':'unknown','error':'已点击发表，但尚未核对到对应的新动态；不自动重发'}
        except Exception as error:
            reason={'desktop_busy':'当前桌面忙碌，已停止发表操作','action_authorization_changed':'发表授权已改变，已停止操作'}.get(str(error),type(error).__name__)
            return {'outcome':'unknown' if submitted else 'draft','error':reason}
        finally:
            if not submitted:
                try:self.ui.abort()
                except Exception:pass

class WeChatMomentUI:
    def __init__(self,get_driver,paused,authorized=lambda:True,report=None,clock=time.monotonic,sleep=time.sleep):
        self.get_driver=get_driver;self.paused=paused;self.authorized=authorized;self.report=report or (lambda *args:None)
        self.clock=clock;self.sleep=sleep;self.pid=None;self.main=None;self.composer=None;self.previous_windows=set();self.preparation_error=''
        self.image_path=None;self.image_hash='';self.image_selected=False
    def fail(self,reason):self.preparation_error=reason;self.report('朋友圈入口检查：'+reason);return None
    @staticmethod
    def descendants(root,limit=3500):
        pending=[root];seen=0
        while pending and seen<limit:
            node=pending.pop(0);seen+=1;yield node
            try:pending.extend(node.GetChildren())
            except Exception:pass
    @staticmethod
    def key(node):
        try:return tuple(node.GetRuntimeId())
        except Exception:return id(node)
    @classmethod
    def unique(cls,nodes):return list({cls.key(n):n for n in nodes}.values())
    @staticmethod
    def name(node):return str(getattr(node,'Name','') or '').strip()
    @staticmethod
    def kind(node):return getattr(node,'ControlTypeName','') or ''
    @staticmethod
    def cls(node):return getattr(node,'ClassName','') or ''
    @staticmethod
    def visible(node):
        try:return not bool(node.IsOffscreen)
        except Exception:return True
    def nodes(self,roots):return self.unique(n for root in roots for n in self.descendants(root) if self.visible(n))
    def named(self,roots,names):
        return [n for n in self.nodes(roots) if self.name(n) in names and (self.kind(n) in ('ButtonControl','TabItemControl','ListItemControl') or 'ExtensionDiscoverContentCell' in self.cls(n))]
    def own_roots(self):
        import uiautomation as automation
        return [w for w in automation.GetRootControl().GetChildren() if getattr(w,'ProcessId',None)==self.pid]
    def available(self):
        if self.paused():raise RuntimeError('desktop_busy')
        if not self.authorized():raise RuntimeError('action_authorization_changed')
    def wait_for(self,read,seconds=4):
        deadline=self.clock()+seconds
        while True:
            self.available();value=read()
            if value:return value
            if self.clock()>=deadline:return None
            self.sleep(.15)
    def click(self,node):self.available();node.Click();self.sleep(.3);self.available()
    def discover_control(self):
        bars=[n for n in self.descendants(self.main) if self.cls(n)=='mmui::MainTabBar']
        if len(bars)==1:
            named=self.named(bars,('发现','Discover'))
            if len(named)==1:return named[0]
            # User-specified fourth navigation item, only within the verified main tab bar.
            tabs=[n for n in self.descendants(bars[0]) if self.cls(n)=='mmui::XTabBarItem' and self.visible(n)]
            if len(tabs)==4:return tabs[3]
        named=self.named([self.main],('发现','Discover'))
        return named[0] if len(named)==1 else None
    def enter_moments(self):
        discover=self.discover_control()
        if discover is not None:self.report('朋友圈流程：进入发现');self.click(discover)
        def locate():
            rows=self.named([self.main],('朋友圈','Moments'))
            return rows[0] if len(rows)==1 else None
        entry=self.wait_for(locate)
        if entry is None:return self.fail('微信已在前台，但未识别到发现页唯一的朋友圈导航按钮')
        self.report('朋友圈流程：进入朋友圈');self.click(entry);return True
    def feed_roots(self):
        return [n for n in self.nodes(self.own_roots()) if self.cls(n) in ('mmui::SNSContentView','mmui::SNSWindow')]
    def camera_control(self):
        feeds=self.feed_roots();roots=feeds or self.own_roots()
        buttons=self.named(roots,('发表朋友圈','发布朋友圈','发布动态','拍照分享','相机','Camera'))
        if len(buttons)==1:return buttons[0]
        if buttons:return None
        # The supplied screenshot shows four controls in the feed's upper-right bar:
        # refresh, notifications, camera, separate window. Select an actual UIA control.
        candidates=[]
        for feed in feeds:
            try:
                r=feed.BoundingRectangle;width=r.right-r.left;height=r.bottom-r.top
                if width<300 or height<200:continue
                group=[]
                for n in self.descendants(feed):
                    if self.kind(n)!='ButtonControl' or not self.visible(n):continue
                    b=n.BoundingRectangle
                    if b.left>=r.left+width*.65 and b.top>=r.top and b.bottom<=r.top+min(120,height*.18) and b.right>b.left and b.bottom>b.top:group.append(n)
                group=self.unique(group)
                if len(group)==4:
                    group.sort(key=lambda n:n.BoundingRectangle.left);candidates.append(group[2])
            except Exception:continue
        candidates=self.unique(candidates)
        return candidates[0] if len(candidates)==1 else None
    def file_pickers(self):
        return [w for w in self.own_roots() if self.cls(w)=='#32770' and self.name(w) in ('打开','Open','选择图片','选择文件')]
    def select_image(self,picker,image_path):
        if getattr(picker,'NativeWindowHandle',0) in self.previous_windows:return self.fail('图片选择窗口已存在，没有接管其他选图操作')
        nodes=list(self.descendants(picker,1800))
        edits=[n for n in nodes if self.kind(n)=='EditControl' and (str(getattr(n,'AutomationId','')) in ('1148','FileNameControlHost') or re.match(r'^(?:文件名|File name)',self.name(n),re.I))]
        if not edits:
            combos=[n for n in nodes if self.kind(n)=='ComboBoxControl' and (str(getattr(n,'AutomationId',''))=='1148' or re.match(r'^(?:文件名|File name)',self.name(n),re.I))]
            edits=[n for combo in combos for n in self.descendants(combo,100) if self.kind(n)=='EditControl']
        edits=self.unique(edits)
        opens=[n for n in nodes if self.kind(n)=='ButtonControl' and re.fullmatch(r'(?:打开|Open)(?:\([A-Za-z]\))?',self.name(n).replace('&',''),re.I)]
        if len(edits)!=1 or len(opens)!=1:return self.fail('图片选择窗口中未识别到唯一的文件名输入框和打开按钮')
        self.available();value=edits[0].GetValuePattern();value.SetValue(image_path)
        if normalized(value.Value).strip('"')!=image_path:return self.fail('图片文件名未能逐字核对，没有确认选图')
        self.click(opens[0])
        if not self.wait_for(lambda:not self.file_pickers()):return self.fail('选择图片后文件窗口仍未关闭，未继续发表')
        self.image_selected=True;self.report('朋友圈流程：已选择任务绑定的配图');return True
    def prepare(self,image_path=None):
        self.preparation_error='';self.image_selected=False;self.available();driver=self.get_driver()
        if driver is None:return self.fail('微信已拉起，但界面自动化驱动不可用')
        ensure=getattr(driver,'ensure_window',None)
        if callable(ensure) and not ensure(wake=False):return self.fail('微信已拉起，但未能重新识别主窗口控件')
        self.main=getattr(driver,'_win',None)
        if self.main is None:return self.fail('微信界面驱动没有可用的主窗口')
        self.pid=self.main.ProcessId;self.previous_windows={getattr(w,'NativeWindowHandle',0) for w in self.own_roots()}
        if self.find_composer() is not None:return self.fail('朋友圈已有打开的编辑窗口，没有接管或覆盖')
        if self.file_pickers():return self.fail('微信已有打开的选图窗口，没有接管')
        if not self.enter_moments():return None
        camera=self.wait_for(self.camera_control)
        if camera is None:return self.fail('已打开朋友圈，但未识别到唯一的相机或发表入口')
        if not image_path or not pathlib.Path(image_path).is_file():return self.fail('此微信发表流程需要配图，未提供已授权图片，没有打开选图窗口')
        self.image_path=str(pathlib.Path(image_path).resolve());self.image_hash=hashlib.sha256(pathlib.Path(self.image_path).read_bytes()).hexdigest()
        self.report('朋友圈流程：点击相机并等待选图');self.click(camera)
        picker=self.wait_for(lambda:self.file_pickers()[0] if len(self.file_pickers())==1 else None)
        if picker is None:return self.fail('已点击相机，但未出现可验证的图片选择窗口')
        if not self.select_image(picker,self.image_path):return None
        self.composer=self.wait_for(self.find_composer)
        if self.composer is None:return self.fail('已选择图片，但未识别到朋友圈文字编辑窗口')
        editors=[n for n in self.descendants(self.composer,1500) if self.kind(n)=='EditControl' and self.visible(n)]
        if len(editors)!=1:return self.fail('已选择图片，但朋友圈正文输入框不唯一')
        self.report('朋友圈流程：已找到正文输入框');return editors[0]
    def find_composer(self):
        nodes=self.nodes(self.own_roots());candidates=[]
        for n in nodes:
            if self.kind(n) not in ('WindowControl','PaneControl','CustomControl') or 'MainWindow' in self.cls(n):continue
            if re.search(r'SNSPublish|SnsPublish|MomentPublish|PublishMoment|SNSPost',self.cls(n)) or self.name(n) in ('发表朋友圈','发布朋友圈'):
                candidates.append((len(list(self.descendants(n,1500))),n))
        # The current unnamed composer is anchored by the screenshot's privacy label.
        # Walk only its ancestors rather than recursively rescanning every timeline pane.
        for anchor in nodes:
            if '谁可以看' not in self.name(anchor):continue
            parent=anchor
            for _ in range(8):
                try:parent=parent.GetParentControl()
                except Exception:break
                if parent is None or 'MainWindow' in self.cls(parent):break
                children=list(self.descendants(parent,700));names=[self.name(x) for x in children]
                if any(value in ('发表','发布','Post') for value in names) and '取消' in names and any(self.kind(x)=='EditControl' for x in children):
                    candidates.append((len(children),parent));break
        if not candidates:return None
        smallest=min(count for count,_ in candidates);matches=self.unique(n for count,n in candidates if count==smallest)
        return matches[0] if len(matches)==1 else None
    def read(self,editor):self.available();return editor.GetValuePattern().Value
    def fill(self,editor,text):self.available();editor.GetValuePattern().SetValue(text)
    def submit_buttons(self):
        return [n for n in self.descendants(self.composer,1500) if self.kind(n)=='ButtonControl' and self.name(n) in ('发表','发布','Post') and self.visible(n)] if self.composer is not None else []
    def ready_to_submit(self,editor):
        self.available();buttons=self.submit_buttons()
        if not self.image_selected or not self.image_path or not pathlib.Path(self.image_path).is_file():return False
        if hashlib.sha256(pathlib.Path(self.image_path).read_bytes()).hexdigest()!=self.image_hash:return False
        return len(buttons)==1 and bool(buttons[0].IsEnabled)
    def submit(self,editor):
        self.available()
        if not self.ready_to_submit(editor):raise RuntimeError('publish_button_unverified')
        self.submit_buttons()[0].Click()
    def abort(self):
        if self.pid is None:return
        # Only close a file picker created by this attempt; keep any composed draft intact.
        for window in self.file_pickers():
            if getattr(window,'NativeWindowHandle',0) not in self.previous_windows:window.GetWindowPattern().Close()
