import pathlib,sys,tempfile,unittest
from types import SimpleNamespace
from unittest import mock
from PIL import Image
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'examples'));sys.path.insert(0,str(ROOT/'tests'))
from moment_dialogs import belongs_to_wechat
from test_moment_images import Flow,Control,Value

class FileDialogTests(unittest.TestCase):
    def fixture(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);image=pathlib.Path(temporary.name)/'鲸鲸 full path.png';Image.new('RGB',(10,10),'blue').save(image);return Flow(image)
    def test_different_title_and_class_still_accepts_a_real_filename_open_dialog(self):
        f=self.fixture();f.picker.Name='选择要上传的图片';f.picker.ClassName='QtFileDialogWindow'
        result=f.publisher().publish('SYNTHETIC_CAPTION',image_path=str(f.image));self.assertEqual(result['outcome'],'sent');self.assertEqual(f.file_value.Value,str(f.image));self.assertEqual(f.open.clicked,1)
    def test_foreign_process_dialog_supplied_by_verified_owner_scope_is_supported(self):
        f=self.fixture();f.picker.ProcessId=456
        f.ui.own_roots=lambda:[f.main]
        f.ui.related_dialog_roots=lambda main:[f.main]+([f.picker] if f.stage=='picker' else [])
        result=f.publisher().publish('SYNTHETIC_CAPTION',image_path=str(f.image));self.assertEqual(result['outcome'],'sent');self.assertEqual(f.file_value.Value,str(f.image))
    def test_filename_host_with_unnamed_edit_receives_the_entire_path(self):
        f=self.fixture();f.file_edit.Name='';f.file_edit.AutomationId='1001';host=Control(kind='PaneControl',aid='FileNameControlHost',children=[f.file_edit]);f.picker.children=[host,f.open]
        result=f.publisher().publish('SYNTHETIC_CAPTION',image_path=str(f.image));self.assertEqual(result['outcome'],'sent');self.assertEqual(f.file_value.Value,str(f.image))
    def test_slow_dialog_initialization_is_waited_for_without_a_second_camera_click(self):
        f=self.fixture();roots=f.ui.own_roots
        f.ui.related_dialog_roots=lambda main:([f.main] if f.stage=='picker' and f.seconds<7 else roots())
        result=f.publisher().publish('SYNTHETIC_CAPTION',image_path=str(f.image));self.assertEqual(result['outcome'],'sent');self.assertEqual(f.camera.clicked,1);self.assertGreaterEqual(f.seconds,7)
    def test_preexisting_picker_is_not_overwritten_even_with_a_new_title(self):
        f=self.fixture();f.stage='picker';f.picker.Name='选取照片';f.picker.ClassName='QtFileDialog'
        f.file_value.Value='EXISTING_USER_SELECTION';result=f.publisher().publish('SYNTHETIC_CAPTION',image_path=str(f.image));self.assertEqual(result['outcome'],'draft');self.assertEqual(f.file_value.Value,'EXISTING_USER_SELECTION');self.assertEqual(f.camera.clicked,0)
    def test_file_list_contents_are_not_traversed(self):
        f=self.fixture();private_list=Control(kind='ListControl');private_list.GetChildren=mock.Mock(side_effect=AssertionError('Do not inspect file names'));f.picker.children.insert(0,private_list)
        result=f.publisher().publish('SYNTHETIC_CAPTION',image_path=str(f.image));self.assertEqual(result['outcome'],'sent');private_list.GetChildren.assert_not_called()

class OwnerScopeTests(unittest.TestCase):
    def related(self,hwnd=20,pid=456,owners=None,pids=None):
        owners=owners or {};pids=pids or {}
        return belongs_to_wechat(hwnd,pid,10,123,owner_of=lambda value:owners.get(value,0),pid_of=lambda value:pids.get(value,999),root_of=lambda value:value)
    def test_native_dialog_owned_by_wechat_is_related(self):self.assertTrue(self.related(owners={20:10},pids={10:123}))
    def test_nested_owner_chain_is_supported(self):self.assertTrue(self.related(owners={20:30,30:10},pids={30:456,10:123}))
    def test_unrelated_app_open_dialog_is_not_accepted(self):self.assertFalse(self.related(owners={20:40},pids={40:999}))
    def test_owner_pid_still_binds_a_dialog_when_qt_has_no_native_main_handle(self):
        self.assertTrue(belongs_to_wechat(20,456,0,123,owner_of=lambda hwnd:10 if hwnd==20 else 0,pid_of=lambda hwnd:123,root_of=lambda hwnd:hwnd))
    def test_owner_cycle_does_not_hang_or_grant_access(self):self.assertFalse(self.related(owners={20:30,30:20}))

if __name__=='__main__':unittest.main()
