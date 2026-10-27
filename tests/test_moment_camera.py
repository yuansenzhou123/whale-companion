import pathlib,sys,tempfile,unittest
from types import SimpleNamespace
from unittest import mock
import numpy as np
from PIL import Image
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'examples'))
from moment_camera import load_reference,detect_camera,VisualCamera,CameraCaptureError,native_click,capture_header
from moment_publisher import WeChatMomentUI

def toolbar(reference,scale=1,centers=(300,),missing=()):
    image=Image.new('RGB',(760,180),(42,42,42))
    for center in centers:
        for name,item in reference['icons'].items():
            if name in missing:continue
            width=round(item['width']*scale);height=round(item['height']*scale)
            mask=Image.fromarray(item['mask'].astype(np.uint8)*255).resize((width,height),Image.Resampling.NEAREST)
            x=round(center+item['dx']*scale-width/2);y=round(85+item['dy']*scale-height/2)
            image.paste((255,255,255),(x,y,x+width,y+height),mask)
    return image

class RecognitionTests(unittest.TestCase):
    def setUp(self):self.reference=load_reference()
    def test_camera_is_found_with_its_neighbouring_toolbar_icons_at_different_scales(self):
        for scale in (.75,1,1.25,1.5,2):
            match=detect_camera(toolbar(self.reference,scale),self.reference)
            self.assertIsNotNone(match,scale);self.assertAlmostEqual((match['box'][0]+match['box'][2])/2,300,delta=2)
    def test_missing_camera_or_context_is_not_a_target(self):
        for missing in [('camera',),('bell',),('refresh',),('window',),('bell','refresh','window')]:self.assertIsNone(detect_camera(toolbar(self.reference,missing=missing),self.reference),missing)
    def test_two_matching_toolbars_are_ambiguous_and_rejected(self):
        self.assertIsNone(detect_camera(toolbar(self.reference,centers=(200,550)),self.reference))
    def test_plain_chat_background_is_not_a_camera_target(self):
        self.assertIsNone(detect_camera(Image.new('RGB',(760,180),'white'),self.reference))
    def test_click_recaptures_and_uses_the_current_window_position(self):
        calls=[];origins=iter([(0,0),(700,200)]);image=toolbar(self.reference)
        capture=lambda hwnd,pid:(image,next(origins),hwnd)
        control=VisualCamera(100,123,lambda:None,self.reference,capture=capture,click=lambda *args:calls.append(args))
        self.assertIsNotNone(control.observe());control.Click();self.assertEqual(calls,[(100,123,(1000,285))])
    def test_changed_icon_stops_before_clicking(self):
        calls=[];frames=iter([toolbar(self.reference),toolbar(self.reference,missing=('camera',))])
        control=VisualCamera(100,123,lambda:None,self.reference,capture=lambda h,p:(next(frames),(0,0),h),click=lambda *args:calls.append(args))
        self.assertIsNotNone(control.observe())
        with self.assertRaisesRegex(CameraCaptureError,'camera_icon_changed'):control.Click()
        self.assertEqual(calls,[])
    def test_revoked_permission_stops_before_capture_or_click(self):
        capture=mock.Mock();click=mock.Mock();control=VisualCamera(100,123,mock.Mock(side_effect=RuntimeError('action_authorization_changed')),self.reference,capture=capture,click=click)
        with self.assertRaisesRegex(RuntimeError,'authorization'):control.Click()
        capture.assert_not_called();click.assert_not_called()
    def test_current_frame_absence_overrides_stale_uia_camera_nodes(self):
        ui=WeChatMomentUI(lambda:None,lambda:False,camera_probe=lambda *args,**kwargs:None);ui.main=SimpleNamespace()
        ui.feed_roots=mock.Mock(side_effect=AssertionError('Should not trust a stale Qt tree'))
        self.assertIsNone(ui.camera_control())

class NativeGuardsTests(unittest.TestCase):
    def test_other_window_covering_the_target_prevents_input(self):
        move=mock.Mock();press=mock.Mock()
        gui=SimpleNamespace(GetForegroundWindow=lambda:100,GetAncestor=lambda hwnd,kind:hwnd,WindowFromPoint=lambda point:999)
        modules={'win32gui':gui,'win32process':SimpleNamespace(),'win32api':SimpleNamespace(SetCursorPos=move,mouse_event=press),'win32con':SimpleNamespace()}
        with mock.patch.dict(sys.modules,modules):
            with self.assertRaisesRegex(CameraCaptureError,'occluded'):native_click(100,123,(300,85))
        move.assert_not_called();press.assert_not_called()
    def test_capture_requires_the_correct_foreground_window_before_reading_pixels(self):
        get_dc=mock.Mock();gui=SimpleNamespace(IsWindow=lambda hwnd:True,GetAncestor=lambda hwnd,kind:hwnd,GetForegroundWindow=lambda:999,GetDC=get_dc)
        modules={'win32gui':gui,'win32ui':SimpleNamespace(),'win32con':SimpleNamespace(),'win32process':SimpleNamespace(GetWindowThreadProcessId=lambda hwnd:(1,123))}
        with mock.patch.dict(sys.modules,modules):
            with self.assertRaisesRegex(CameraCaptureError,'not_foreground'):capture_header(100,123)
        get_dc.assert_not_called()

class OpaqueCameraFlowTests(unittest.TestCase):
    def test_image_recognition_replaces_missing_uia_button_in_the_full_flow(self):
        sys.path.insert(0,str(ROOT/'tests'));from test_moment_images import Flow
        with tempfile.TemporaryDirectory() as temporary:
            image=pathlib.Path(temporary)/'synthetic.png';Image.new('RGB',(10,10),'blue').save(image)
            flow=Flow(image);flow.stage='feed';flow.camera.Name='';flow.camera.ControlTypeName='CustomControl';reference=load_reference()
            def probe(main,available,report=None):
                frame=toolbar(reference) if flow.stage=='feed' else Image.new('RGB',(760,180),'white')
                return VisualCamera(10,123,available,reference,capture=lambda h,p:(frame,(0,0),h),click=lambda h,p,point:flow.camera.Click()).observe()
            flow.ui.camera_probe=probe
            result=flow.publisher().publish('SYNTHETIC_CAPTION',image_path=str(image))
            self.assertEqual(result['outcome'],'sent');self.assertEqual(flow.camera.clicked,1);self.assertEqual(flow.entry.clicked,0);self.assertEqual(flow.tabs[-1].clicked,0)

if __name__=='__main__':unittest.main()
