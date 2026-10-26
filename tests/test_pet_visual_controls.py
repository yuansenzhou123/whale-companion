import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'companion/desktop'))
from pet_controls import VisualCatalog,VisualControls,menu_groups
from live2d_renderer import DEFAULT_MODEL

class VisualTests(unittest.TestCase):
    def setUp(self):
        self.catalog = VisualCatalog(DEFAULT_MODEL)

    def test_every_supplied_option_and_motion_is_available_once(self):
        controls = VisualControls(self.catalog)
        entries = [row for _,rows in menu_groups(self.catalog,controls) for row in rows]
        reachable = [value for kind,value,_,_ in entries if kind in {'face','toggle','gesture'} and value is not None and value != '手机']
        self.assertEqual(set(reachable),set(self.catalog.expressions))
        self.assertEqual(len(reachable),44)
        self.assertEqual(len([r for r in entries if r[0]=='motion']),7)
        for motion in self.catalog.model['FileReferences']['Motions']['Actions']:
            data = json.loads((DEFAULT_MODEL.parent/motion['File']).read_text(encoding='utf-8'))
            self.assertFalse(data['Meta']['Loop'])
        idle = json.loads((DEFAULT_MODEL.parent/'motions/idle.motion3.json').read_text())
        self.assertTrue(idle['Meta']['Loop'])

    def test_appearance_and_face_survive_restart_and_exclusive_choices_replace(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp)/'visual.json'
            controls = VisualControls(self.catalog,file)
            controls.toggle('深色桌布')
            controls.toggle('圆眼镜')
            controls.toggle('墨镜')
            controls.toggle('猫猫贴纸')
            controls.toggle('兔兔贴纸')
            controls.set_face('脸红')
            loaded = VisualControls(self.catalog,file)
            self.assertEqual(loaded.manual_face,'脸红')
            self.assertEqual(loaded.enabled,{'深色桌布','墨镜','兔兔贴纸'})
            loaded.set_face(None)
            self.assertIsNone(loaded.manual_face)
            self.assertIn('深色桌布',loaded.enabled)

    def test_toggle_off_and_separate_reset_leave_other_choices_intact(self):
        controls = VisualControls(self.catalog)
        controls.toggle('头箍')
        controls.toggle('鲸鱼')
        controls.toggle('头箍')
        self.assertEqual(controls.enabled,{'鲸鱼'})
        controls.toggle('单边马尾')
        controls.reset('props')
        self.assertEqual(controls.enabled,{'单边马尾'})
        controls.toggle('鲸鱼')
        controls.reset('appearance')
        self.assertEqual(controls.enabled,{'鲸鱼'})

    def test_transient_action_requirements_neither_stack_nor_overwrite_saved_outfit(self):
        controls = VisualControls(self.catalog)
        controls.toggle('手机')
        controls.toggle('深色桌布')
        controls.toggle('鲸鱼')
        defaults = {'phone':0,'cc2':0,'jingyu':0,'point':0,'danbaofan':0}
        first = controls.overlay(defaults,defaults,extra=['鲸鱼'])
        second = controls.overlay(defaults,defaults,extra=['鲸鱼'])
        self.assertEqual(first,second)
        self.assertEqual(first['jingyu'],1)
        cooking = controls.overlay(defaults,defaults,extra=['蛋包饭'])
        self.assertNotIn('phone',cooking)
        self.assertEqual(cooking['danbaofan'],1)
        self.assertIn('手机',controls.enabled)
        # A motion controls its own animated hand position rather than freezing it.
        self.assertNotIn('danbaofan',controls.overlay(defaults,defaults,extra=['蛋包饭'],skip={'danbaofan'}))

    def test_unknown_menu_values_cannot_write_arbitrary_visual_state(self):
        controls = VisualControls(self.catalog)
        with self.assertRaises(ValueError):controls.toggle('../../elsewhere')
        with self.assertRaises(ValueError):controls.set_face('不存在')

    def test_dependent_props_enable_parent_and_reset_when_parent_is_removed(self):
        controls = VisualControls(self.catalog)
        controls.toggle('蛋包饭')
        controls.toggle('手机换色')
        self.assertEqual(controls.enabled,{'手机','手机换色'})
        controls.toggle('手机')
        self.assertFalse(controls.enabled)
        controls.toggle('鲸鱼放桌上')
        self.assertEqual(controls.enabled,{'鲸鱼','鲸鱼放桌上'})
        controls.toggle('鲸鱼')
        self.assertFalse(controls.enabled)

if __name__ == '__main__':
    unittest.main(verbosity=2)
