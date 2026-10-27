"""Moments publishing through scoped UIA controls, with verified approved image input.

Discover -> Moments -> camera -> native file picker -> caption -> publish.
The camera may use a fresh, window-bound local image match. No blind coordinates, privacy-setting changes, or automatic retries.
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
            reason={'desktop_busy':'当前桌面忙碌，已停止发表操作','action_authorization_changed':'发表授权已改变，已停止操作','camera_window_missing':'未找到可核对的微信窗口，没有点击相机','camera_window_changed':'微信窗口绑定已变化，没有点击相机','camera_window_not_foreground':'微信已不在前台，没有继续点击相机','camera_window_hidden':'微信窗口已隐藏，没有点击相机','camera_window_too_small':'微信窗口过小，无法核对相机图标','camera_capture_failed':'无法读取微信顶部画面，没有继续点击相机','camera_target_occluded':'相机位置被其他窗口遮挡，没有点击','camera_icon_changed':'点击前相机图标已变化，没有继续点击'}.get(str(error),type(error).__name__)
            return {'outcome':'unknown' if submitted else 'draft','error':reason}
        finally:
            if not submitted:
                try:self.ui.abort()
                except Exception:pass

class WeChatMomentUI:
    def __init__(self,get_driver,paused,authorized=lambda:True,report=None,clock=time.monotonic,sleep=time.sleep,camera_probe=None,dialog_roots=None):
        self.get_driver=get_driver;self.paused=paused;self.authorized=authorized;self.report=report or (lambda *args:None)
        self.clock=clock;self.sleep=sleep;self.pid=None;self.main=None;self.composer=None;self.previous_windows=set();self.preparation_error=''
        self.image_path=None;self.image_hash='';self.image_selected=False;self.camera_probe=camera_probe;self.related_dialog_roots=dialog_roots;self.previous_pickers=set()
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
    def camera_ready(self):
        self.available();camera=self.camera_control()
        if camera is None or not self.visible(camera):return None
        try:
            if not bool(getattr(camera,'IsEnabled',True)):return None
            rect=camera.BoundingRectangle
            if rect.right<=rect.left or rect.bottom<=rect.top:return None
        except AttributeError:pass
        except Exception:return None
        return camera
    def enter_moments(self):
        # Re-entry must not toggle an already open timeline back out of view.
        if self.camera_ready() is not None:
            self.report('朋友圈流程：当前页面已可选图，跳过发现和朋友圈导航');return True
        discover=self.discover_control()
        if discover is not None:
            self.report('朋友圈流程：进入发现');self.click(discover)
            # Discover can restore its last subpage asynchronously.
            if self.wait_for(self.camera_ready,seconds=1.2) is not None:
                self.report('朋友圈流程：发现已恢复朋友圈页面，直接进入选图');return True
        def locate():
            rows=self.named([self.main],('朋友圈','Moments'))
            return rows[0] if len(rows)==1 else None
        entry=self.wait_for(locate)
        # The timeline may finish restoring while its entry is being located.
        if self.camera_ready() is not None:
            self.report('朋友圈流程：朋友圈页面已就绪，取消重复导航');return True
        if entry is None:return self.fail('微信已在前台，但未识别到发现页唯一的朋友圈导航按钮')
        self.report('朋友圈流程：进入朋友圈');self.click(entry);return True
    def feed_roots(self):
        return [n for n in self.nodes(self.own_roots()) if self.cls(n) in ('mmui::SNSContentView','mmui::SNSWindow')]
    def camera_control(self):
        # Qt can retain stale offscreen flags/rectangles. A successful current-frame
        # observation is authoritative, including the absence of the toolbar.
        if self.camera_probe is not None:return self.camera_probe(self.main,self.available,report=self.report)
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
    def dialog_roots(self):
        return self.related_dialog_roots(self.main) if self.related_dialog_roots else self.own_roots()
    def picker_controls(self,root):
        # Skip file/folder lists: only the filename field and Open button are needed.
        pending=[root];nodes=[]
        while pending and len(nodes)<1500:
            node=pending.pop(0);nodes.append(node)
            if self.kind(node) in ('ListControl','TreeControl','DataGridControl','ListItemControl','TreeItemControl','DataItemControl'):continue
            try:pending.extend(node.GetChildren())
            except Exception:pass
        def filename(node):
            return str(getattr(node,'AutomationId','')) in ('1148','FileNameControlHost','FileNameComboBox') or bool(re.match(r'^(?:文件名|File name)',self.name(node),re.I))
        edits=[node for node in nodes if self.kind(node)=='EditControl' and filename(node)]
        hosts=[node for node in nodes if filename(node)]
        for host in hosts:
            edits.extend(node for node in self.descendants(host,100) if self.kind(node)=='EditControl')
        edits=self.unique(edits)
        if not edits:edits=self.unique(node for node in hosts if self.kind(node)=='ComboBoxControl')
        def under_combo(node):
            parent=node
            for _ in range(10):
                try:parent=parent.GetParentControl()
                except Exception:break
                if parent is None:break
                if self.kind(parent)=='ComboBoxControl' or 'combobox' in self.cls(parent).lower():return True
                if self.key(parent)==self.key(root):break
            return False
        def open_name(node):
            name=self.name(node).replace('&','').replace('（','(').replace('）',')')
            return bool(re.fullmatch(r'(?:打开|Open)(?:\([A-Za-z]\))?',name,re.I))
        buttons=self.unique(node for node in nodes if (self.kind(node) in ('ButtonControl','SplitButtonControl') or self.cls(node).lower()=='button') and open_name(node) and 'dropdown' not in str(getattr(node,'AutomationId','')).lower() and not under_combo(node))
        # Common file dialogs expose the real default Open action as IDOK=1.
        # The filename combo's arrow can also be named "Open"; it is not IDOK.
        standard=[node for node in buttons if str(getattr(node,'AutomationId',''))=='1']
        opens=standard if standard else buttons
        return edits,opens
    def file_pickers(self):
        candidates=[]
        for root in self.dialog_roots():
            edits,opens=self.picker_controls(root)
            if not edits or not opens:continue
            if 'MainWindow' not in self.cls(root) and (not self.main or getattr(root,'NativeWindowHandle',0)!=getattr(self.main,'NativeWindowHandle',0)):
                candidates.append(root);continue
            # Qt may embed a chooser pane in the main window rather than a new #32770.
            for edit in edits:
                parent=edit
                for _ in range(8):
                    try:parent=parent.GetParentControl()
                    except Exception:break
                    if parent is None or 'MainWindow' in self.cls(parent):break
                    fields,buttons=self.picker_controls(parent)
                    if fields and buttons:candidates.append(parent);break
        return self.unique(candidates)
    def picker_diagnostics(self):
        details=[]
        for root in self.dialog_roots():
            edits,opens=self.picker_controls(root)
            details.append({'class':self.cls(root)[:80],'sameProcess':getattr(root,'ProcessId',None)==self.pid,'filenameFields':len(edits),'openButtons':len(opens)})
        self.report('朋友圈选图窗口检查：'+str(details[:6]))
    def collapse_filename_history(self,edit):
        parent=edit
        for _ in range(10):
            if self.kind(parent)=='ComboBoxControl' or 'combobox' in self.cls(parent).lower():
                try:
                    pattern=parent.GetExpandCollapsePattern()
                    if pattern is not None and pattern.ExpandCollapseState!=0:
                        self.available();pattern.Collapse();self.report('朋友圈流程：已收起文件名历史列表')
                except Exception:pass
                return
            try:parent=parent.GetParentControl()
            except Exception:return
            if parent is None:return
    def invoke_picker_open(self,button):
        self.available()
        if not bool(getattr(button,'IsEnabled',True)):return self.fail('选图窗口的打开按钮尚不可用，没有重复点击')
        action=None;method=''
        try:
            pattern=button.GetInvokePattern()
            if pattern is not None:action=pattern.Invoke;method='Invoke'
        except Exception:pass
        if action is None:
            try:
                pattern=button.GetLegacyIAccessiblePattern()
                if pattern is not None:action=pattern.DoDefaultAction;method='DefaultAction'
            except Exception:pass
        if action is None:return self.fail('选图窗口的打开按钮不支持可核实的确认动作，未点击下拉箭头')
        self.available();self.report('朋友圈流程：确认打开图片（控件ID=%s，类型=%s，动作=%s）'%(str(getattr(button,'AutomationId',''))[:30],self.kind(button),method))
        try:action()
        except Exception:self.report('朋友圈选图确认返回异常，仅检查窗口是否关闭，不重复确认')
        return True
    def select_image(self,picker,image_path):
        handle=getattr(picker,'NativeWindowHandle',0)
        if self.key(picker) in self.previous_pickers or handle and handle in self.previous_windows:return self.fail('图片选择窗口已存在，没有接管其他选图操作')
        edits,opens=self.picker_controls(picker)
        if len(edits)!=1 or len(opens)!=1:return self.fail('图片选择窗口中未识别到唯一的文件名输入框和打开按钮')
        self.report('朋友圈流程：向选图窗口文件名栏填入任务图片的完整路径')
        self.collapse_filename_history(edits[0]);self.available();value=edits[0].GetValuePattern();value.SetValue(image_path)
        if normalized(value.Value).strip('"')!=image_path:return self.fail('图片文件名未能逐字核对，没有确认选图')
        self.collapse_filename_history(edits[0])
        # Collapse can change the live tree; rebind the true Open action and recheck text.
        fields,buttons=self.picker_controls(picker)
        if len(fields)!=1 or len(buttons)!=1:return self.fail('收起历史列表后打开按钮不唯一，没有继续确认')
        if normalized(fields[0].GetValuePattern().Value).strip('"')!=image_path:return self.fail('收起历史列表后图片路径已变化，没有确认打开')
        if not self.invoke_picker_open(buttons[0]):return None
        if not self.wait_for(lambda:not self.file_pickers(),seconds=8):return self.fail('已确认打开图片，但文件窗口仍未关闭；没有重复点击')
        self.image_selected=True;self.report('朋友圈流程：已选择任务绑定的配图');return True
    def prepare(self,image_path=None):
        self.preparation_error='';self.image_selected=False;self.available();driver=self.get_driver()
        if driver is None:return self.fail('微信已拉起，但界面自动化驱动不可用')
        ensure=getattr(driver,'ensure_window',None)
        if callable(ensure) and not ensure(wake=False):return self.fail('微信已拉起，但未能重新识别主窗口控件')
        self.main=getattr(driver,'_win',None)
        if self.main is None:return self.fail('微信界面驱动没有可用的主窗口')
        self.pid=self.main.ProcessId;self.previous_windows={getattr(w,'NativeWindowHandle',0) for w in self.dialog_roots() if getattr(w,'NativeWindowHandle',0)}
        if self.find_composer() is not None:return self.fail('朋友圈已有打开的编辑窗口，没有接管或覆盖')
        existing_pickers=self.file_pickers();self.previous_pickers={self.key(window) for window in existing_pickers}
        if existing_pickers:return self.fail('微信已有打开的选图窗口，请先取消上次遗留的选图再试')
        if not self.enter_moments():return None
        camera=self.wait_for(self.camera_ready)
        if camera is None:return self.fail('已打开朋友圈，但未识别到唯一的相机或发表入口')
        if not image_path or not pathlib.Path(image_path).is_file():return self.fail('此微信发表流程需要配图，未提供已授权图片，没有打开选图窗口')
        self.image_path=str(pathlib.Path(image_path).resolve());self.image_hash=hashlib.sha256(pathlib.Path(self.image_path).read_bytes()).hexdigest()
        self.report('朋友圈流程：点击相机并等待选图');self.click(camera)
        def locate_picker():
            pickers=self.file_pickers()
            return pickers[0] if len(pickers)==1 else None
        picker=self.wait_for(locate_picker,seconds=12)
        if picker is None:
            self.picker_diagnostics();return self.fail('已点击相机，但未识别到归属微信且带文件名输入框的选图窗口')
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
