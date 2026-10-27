import hashlib,os,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from PIL import Image
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'examples'))
from moment_media import prepare_moment_image
from moment_publisher import MomentPublisher,WeChatMomentUI
from wechat_action_worker import WeChatActionWorker

class Control:
    def __init__(self,name='',kind='PaneControl',cls='',children=(),click=None,handle=0,value=None,aid=''):
        self.Name=name;self.ControlTypeName=kind;self.ClassName=cls;self.children=list(children);self.ProcessId=123;self.NativeWindowHandle=handle;self.IsOffscreen=False;self.IsEnabled=True;self.AutomationId=aid;self.value=value;self.clicked=0;self.action=click
        for child in self.children:child.parent=self
    def GetParentControl(self):return getattr(self,'parent',None)
    def GetChildren(self):return self.children
    def Click(self):
        self.clicked+=1
        if self.action:self.action()
    def GetValuePattern(self):return self.value
    def GetWindowPattern(self):return SimpleNamespace(Close=lambda:None)

class Value:
    def __init__(self,setter=lambda v:None):self.Value='';self.setter=setter
    def SetValue(self,value):self.Value=value;self.setter(value)

class Flow:
    def __init__(self,image):
        self.stage='chat';self.seconds=0;self.allowed=True;self.image=image;self.events=[];self.posted=False;self.include_image=True;self.mutate_on_fill=False
        self.file_value=Value();self.caption_value=Value(self.caption_written)
        self.tabs=[Control(name,'ButtonControl','mmui::XTabBarItem') for name in ['微信','通讯录','收藏','发现']];self.tabs[-1].action=lambda:self.change('discover')
        self.bar=Control(cls='mmui::MainTabBar',children=self.tabs)
        self.entry=Control('朋友圈','ListItemControl','mmui::ExtensionDiscoverContentCell',click=lambda:self.change('feed'))
        self.camera=Control('相机','ButtonControl',click=lambda:self.change('picker'))
        self.feed=Control(cls='mmui::SNSContentView',children=[self.camera])
        self.file_edit=Control('文件名(N):','EditControl',value=self.file_value,aid='1148')
        self.open=Control('打开(O)','ButtonControl',click=self.open_file)
        self.picker=Control('打开','WindowControl','#32770',children=[self.file_edit,self.open],handle=20)
        self.caption=Control('这一刻的想法...','EditControl',value=self.caption_value)
        self.publish=Control('发表','ButtonControl',click=self.submit)
        self.cancel=Control('取消','ButtonControl')
        self.composer=Control(children=[self.caption,Control('谁可以看'),self.publish,self.cancel])
        self.main=Control('微信','WindowControl','mmui::MainWindow',handle=10)
        self.main.GetChildren=self.children
        driver=SimpleNamespace(_win=self.main,ensure_window=lambda **kwargs:True)
        self.ui=WeChatMomentUI(lambda:driver,lambda:False,lambda:self.allowed,clock=lambda:self.seconds,sleep=self.sleep)
        self.ui.own_roots=lambda:[self.main]+([self.picker] if self.stage=='picker' else [])
    def sleep(self,seconds):self.seconds+=seconds
    def change(self,stage):self.events.append(stage);self.stage=stage
    def children(self):
        return [self.bar]+([self.entry] if self.stage!='chat' else [])+([self.feed] if self.stage in ('feed','picker','compose','posted') else [])+([self.composer] if self.stage in ('compose','posted') else [])
    def open_file(self):
        if self.file_value.Value!=str(self.image):raise AssertionError('Wrong image selected')
        self.change('compose')
    def caption_written(self,value):
        self.events.append('caption')
        if self.mutate_on_fill:self.image.write_bytes(b'changed')
    def submit(self):self.posted=True;self.change('posted')
    def posts(self):return [{'id':'new-self-post','text':self.caption_value.Value,'images':[{'md5':'synthetic'}] if self.include_image else []}] if self.posted else []
    def publisher(self):return MomentPublisher(self.ui,self.posts,clock=lambda:self.seconds,sleep=self.sleep)

class ImageFlowTests(unittest.TestCase):
    def fixture(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);image=Path(temporary.name)/'image.png';Image.new('RGBA',(12,12),'blue').save(image);return Flow(image)
    def test_user_supplied_discover_camera_picker_caption_sequence(self):
        f=self.fixture();result=f.publisher().publish('SYNTHETIC_CAPTION',image_path=str(f.image));self.assertEqual(result['outcome'],'sent');self.assertEqual(f.events,['discover','feed','picker','compose','caption','posted']);self.assertEqual(f.publish.clicked,1)
    def test_existing_user_composer_is_preserved(self):
        f=self.fixture();f.stage='compose';f.caption_value.Value='EXISTING_USER_DRAFT';result=f.publisher().publish('SYNTHETIC_CAPTION',image_path=str(f.image));self.assertEqual(result['outcome'],'draft');self.assertEqual(f.caption_value.Value,'EXISTING_USER_DRAFT');self.assertEqual(f.events,[])
    def test_missing_approved_image_never_opens_picker(self):
        f=self.fixture();result=f.publisher().publish('SYNTHETIC_CAPTION');self.assertEqual(result['outcome'],'draft');self.assertIn('需要配图',result['error']);self.assertEqual(f.camera.clicked,0)
    def test_changed_image_before_submit_is_rejected(self):
        f=self.fixture();f.mutate_on_fill=True;result=f.publisher().publish('SYNTHETIC_CAPTION',image_path=str(f.image));self.assertEqual(result['outcome'],'draft');self.assertEqual(f.publish.clicked,0)
    def test_revoked_permission_during_selection_does_not_open_or_publish(self):
        f=self.fixture();f.file_value.setter=lambda v:setattr(f,'allowed',False);result=f.publisher().publish('SYNTHETIC_CAPTION',image_path=str(f.image));self.assertEqual(result['outcome'],'draft');self.assertEqual(f.open.clicked,0);self.assertEqual(f.publish.clicked,0)
    def test_new_post_without_image_is_not_confirmed_as_success(self):
        f=self.fixture();f.include_image=False;result=f.publisher().publish('SYNTHETIC_CAPTION',image_path=str(f.image));self.assertEqual(result['outcome'],'unknown');self.assertEqual(f.publish.clicked,1)
    def test_ambiguous_filename_field_prevents_image_selection(self):
        f=self.fixture();f.picker.children.append(Control('文件名','EditControl',aid='1148',value=Value()));result=f.publisher().publish('SYNTHETIC_CAPTION',image_path=str(f.image));self.assertEqual(result['outcome'],'draft');self.assertEqual(f.open.clicked,0);self.assertEqual(f.publish.clicked,0)

class AssetTests(unittest.TestCase):
    def fixture(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);root=Path(temporary.name);(root/'emotion').mkdir();source=root/'emotion/鲸鲸.gif';Image.new('RGB',(8,8),'red').save(source,save_all=True,append_images=[Image.new('RGB',(8,8),'blue')],format='GIF',duration=100)
        body=source.read_bytes();media={'source':'emotion','relativePath':'emotion/鲸鲸.gif','sha256':hashlib.sha256(body).hexdigest(),'bytes':len(body)};return root,source,media,body
    def test_gif_becomes_static_png_and_original_remains_unchanged(self):
        root,source,media,body=self.fixture();output=prepare_moment_image(root,media)
        with Image.open(output) as image:self.assertEqual(image.format,'PNG');self.assertEqual(getattr(image,'n_frames',1),1)
        self.assertEqual(source.read_bytes(),body)
    def test_outside_or_changed_image_is_rejected(self):
        root,source,media,body=self.fixture()
        for relative in ['../private.gif','emotion/../private.gif','C:/private.gif']:
            with self.assertRaises(ValueError):prepare_moment_image(root,{**media,'relativePath':relative})
        source.write_bytes(b'changed')
        with self.assertRaises(ValueError):prepare_moment_image(root,media)
    def test_worker_rejects_tampered_media_binding_before_publisher(self):
        root,source,media,body=self.fixture();text='SYNTHETIC_CAPTION';publisher=mock.Mock();job={'id':'job','lease':'lease','kind':'moment_text','text':text,'media':media,'mediaHash':'tampered','contentHash':hashlib.sha256(text.encode()).hexdigest()};acks=[]
        def post(url,**kwargs):
            if url.endswith('/next'):result={'ok':True,'job':job}
            elif url.endswith('/validate'):result={'ok':True,'valid':True}
            else:acks.append(kwargs['json']);result={'ok':True}
            return SimpleNamespace(raise_for_status=lambda:None,json=lambda:result)
        worker=WeChatActionWorker('http://synthetic','token',SimpleNamespace(post=post),mock.Mock(),publisher,lambda:False,lambda s:s,lambda *args:None);worker.poll_once();publisher.assert_not_called();self.assertEqual(acks[0]['outcome'],'failed')

if __name__=='__main__':unittest.main()
