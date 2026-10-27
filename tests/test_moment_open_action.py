import pathlib,sys,tempfile,unittest
from types import SimpleNamespace
from unittest import mock
from PIL import Image
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'examples'));sys.path.insert(0,str(ROOT/'tests'))
from test_moment_images import Flow,Control

class OpenActionTests(unittest.TestCase):
    def fixture(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);image=pathlib.Path(temporary.name)/'image full path.png';Image.new('RGB',(10,10),'blue').save(image)
        flow=Flow(image);flow.open.AutomationId='1';return flow
    def run_flow(self,flow):return flow.publisher().publish('SYNTHETIC_CAPTION',image_path=str(flow.image))
    def mouse_trap(self,flow):flow.open.Click=mock.Mock(side_effect=AssertionError('Never coordinate-click Open'))
    def test_filename_arrow_named_open_is_not_the_real_split_open_button(self):
        f=self.fixture();arrow=Control('打开','ButtonControl',aid='DropDown');combo=Control(kind='ComboBoxControl',aid='1148',children=[f.file_edit,arrow]);combo.parent=f.picker;f.picker.children=[combo,f.open]
        f.open.ControlTypeName='SplitButtonControl';invoke=mock.Mock(side_effect=f.open_file);f.open.GetInvokePattern=lambda:SimpleNamespace(Invoke=invoke);self.mouse_trap(f)
        result=self.run_flow(f);self.assertEqual(result['outcome'],'sent');self.assertEqual(arrow.clicked,0);f.open.Click.assert_not_called();invoke.assert_called_once()
    def test_flattened_dropdown_with_no_parent_link_is_still_not_open(self):
        f=self.fixture();arrow=Control('打开','ButtonControl',aid='DropDown');f.picker.children=[f.file_edit,arrow]
        fields,buttons=f.ui.picker_controls(f.picker);self.assertEqual(len(fields),1);self.assertEqual(buttons,[])
    def test_idok_has_priority_over_other_open_labels(self):
        f=self.fixture();other=Control('打开','ButtonControl',aid='42');f.picker.children.insert(0,other)
        result=self.run_flow(f);self.assertEqual(result['outcome'],'sent');self.assertEqual(other.clicked,0);self.assertEqual(f.open.clicked,1)
    def test_file_type_combo_arrow_is_also_excluded(self):
        f=self.fixture();arrow=Control('打开','ButtonControl');combo=Control('图片或视频','ComboBoxControl',children=[arrow]);f.picker.children.insert(0,combo)
        self.assertEqual(self.run_flow(f)['outcome'],'sent');self.assertEqual(arrow.clicked,0)
    def test_expanded_filename_history_is_collapsed_without_mouse_input(self):
        f=self.fixture();state={'expanded':1};collapse=mock.Mock(side_effect=lambda:state.update(expanded=0));combo=Control(kind='ComboBoxControl',aid='1148',children=[f.file_edit]);combo.parent=f.picker;combo.GetExpandCollapsePattern=lambda:SimpleNamespace(ExpandCollapseState=state['expanded'],Collapse=collapse);f.picker.children=[combo,f.open]
        self.assertEqual(self.run_flow(f)['outcome'],'sent');collapse.assert_called_once()
    def test_legacy_default_action_is_used_when_invoke_is_unsupported(self):
        f=self.fixture();f.open.GetInvokePattern=mock.Mock(side_effect=NotImplementedError());action=mock.Mock(side_effect=f.open_file);f.open.GetLegacyIAccessiblePattern=lambda:SimpleNamespace(DoDefaultAction=action);self.mouse_trap(f)
        self.assertEqual(self.run_flow(f)['outcome'],'sent');action.assert_called_once();f.open.Click.assert_not_called()
    def test_unsupported_actions_do_not_fall_back_to_an_arrow_coordinate_click(self):
        f=self.fixture();f.open.GetInvokePattern=mock.Mock(side_effect=NotImplementedError());f.open.GetLegacyIAccessiblePattern=mock.Mock(side_effect=NotImplementedError());self.mouse_trap(f)
        result=self.run_flow(f);self.assertEqual(result['outcome'],'draft');self.assertIn('不支持可核实的确认动作',result['error']);f.open.Click.assert_not_called();self.assertFalse(f.posted)
    def test_invoke_exception_after_dialog_closed_does_not_repeat_confirmation(self):
        f=self.fixture()
        def action():f.open_file();raise OSError('provider disappeared')
        invoke=mock.Mock(side_effect=action);legacy=mock.Mock(side_effect=AssertionError('Do not retry an attempted action'));f.open.GetInvokePattern=lambda:SimpleNamespace(Invoke=invoke);f.open.GetLegacyIAccessiblePattern=legacy;self.mouse_trap(f)
        self.assertEqual(self.run_flow(f)['outcome'],'sent');invoke.assert_called_once();legacy.assert_not_called();f.open.Click.assert_not_called()
    def test_slow_file_open_is_observed_without_repeating_invoke(self):
        f=self.fixture();state={'due':None}
        def action():state['due']=f.seconds+6
        def advance(seconds):
            f.seconds+=seconds
            if state['due'] is not None and f.seconds>=state['due']:state['due']=None;f.open_file()
        invoke=mock.Mock(side_effect=action);f.open.GetInvokePattern=lambda:SimpleNamespace(Invoke=invoke);f.ui.sleep=advance;self.mouse_trap(f)
        self.assertEqual(self.run_flow(f)['outcome'],'sent');invoke.assert_called_once();f.open.Click.assert_not_called()

if __name__=='__main__':unittest.main()
