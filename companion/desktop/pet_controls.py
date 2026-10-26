"""Catalog and persistent visual choices, independent from chat and OpenGL."""
import json
from pathlib import Path

APPEARANCE = {'单边马尾','头箍','深色桌布','圆眼镜','方眼镜','椭圆眼镜','墨镜','兔兔贴纸','猫猫贴纸','蝴蝶结贴纸'}
PROPS = {'鲸鱼','鲸鱼放桌上','蛋包饭','巴菲','手机换色','画笔','橡皮','魔爪','魔爪换色'}
GESTURES = {'双手比耶','喵喵手~喵~动画','挤','撤回','点菜按下'}
EXCLUSIVE = [ {'圆眼镜','方眼镜','椭圆眼镜','墨镜'}, {'兔兔贴纸','猫猫贴纸','蝴蝶结贴纸'}, {'画笔','橡皮','蛋包饭','手机'} ]
DEPENDENCIES = {'鲸鱼放桌上':'鲸鱼','魔爪换色':'魔爪','手机换色':'手机'}
LABELS = {'头箍':'摘掉头箍','巴菲':'收起芭菲','love':'冒爱心','喵喵手~喵~动画':'猫猫手','挤':'挤番茄酱（姿势）','点菜按下':'按下点菜单','撤回':'撤回姿势','鲸鱼':'头顶鲸鱼','手机换色':'手机换色','魔爪换色':'魔爪变白'}

class VisualCatalog:
    def __init__(self, model_path):
        model_path = Path(model_path)
        self.modeldir = model_path.parent.resolve()
        self.model = json.loads(model_path.read_text(encoding='utf-8'))
        self.expressions = {}
        for row in self.model['FileReferences'].get('Expressions',[]):
            path = (self.modeldir/row['File']).resolve()
            if not path.is_relative_to(self.modeldir):
                raise ValueError('Invalid expression path')
            self.expressions[row['Name']] = json.loads(path.read_text(encoding='utf-8'))['Parameters']
        self.faces = [n for n in self.expressions if n not in APPEARANCE|PROPS|GESTURES]
        self.appearance = [n for n in self.expressions if n in APPEARANCE]
        self.props = [n for n in self.expressions if n in PROPS] + ['手机']
        self.gestures = [n for n in self.expressions if n in GESTURES]
        self.motions = {row['id']:row for row in self.model.get('WhaleCompanion',{}).get('motions',[])}

    def parameters(self, names):
        rows = []
        for name in names:
            if name == '手机':
                rows.append({'Id':'phone','Value':1.,'Blend':'Add'})
            else:
                rows.extend(self.expressions.get(name,[]))
        return rows

class VisualControls:
    def __init__(self, catalog, file=None):
        self.catalog = catalog
        self.file = Path(file) if file else None
        self.manual_face = None
        self.allow_capture = False
        self.enabled = set()
        if self.file:
            try:
                saved = json.loads(self.file.read_text(encoding='utf-8'))
                self.allow_capture = saved.get('allowCapture') is True
                if saved.get('face') in catalog.faces:
                    self.manual_face = saved['face']
                for name in saved.get('enabled',[]):
                    if name in catalog.appearance + catalog.props and name not in self.enabled:
                        self.toggle(name, save=False)
            except (OSError, ValueError, TypeError):
                self.manual_face = None
                self.enabled = set()

    def set_allow_capture(self, allowed):
        if not isinstance(allowed,bool):
            raise ValueError('Capture preference must be boolean')
        self.allow_capture = allowed
        self.save()

    def set_face(self, name):
        if name is not None and name not in self.catalog.faces:
            raise ValueError('Unknown face')
        self.manual_face = name
        self.save()

    def toggle(self, name, save=True):
        if name not in self.catalog.appearance + self.catalog.props:
            raise ValueError('Unknown visual option')
        if name in self.enabled:
            self.remove({name})
        else:
            for group in EXCLUSIVE:
                if name in group:
                    self.remove(group)
            dependency = DEPENDENCIES.get(name)
            if dependency and dependency not in self.enabled:
                self.toggle(dependency,save=False)
            self.enabled.add(name)
        if save:
            self.save()

    def remove(self,names):
        names = set(names)
        for child,parent in DEPENDENCIES.items():
            if parent in names:
                names.add(child)
        self.enabled.difference_update(names)

    def reset(self, group):
        if group == 'appearance':
            self.enabled.difference_update(self.catalog.appearance)
        elif group == 'props':
            self.enabled.difference_update(self.catalog.props)
        else:
            raise ValueError('Unknown visual group')
        self.save()

    def save(self):
        if self.file:
            self.file.parent.mkdir(parents=True,exist_ok=True)
            tmp = self.file.with_suffix('.tmp')
            tmp.write_text(json.dumps({'version':1,'allowCapture':self.allow_capture,'face':self.manual_face,'enabled':sorted(self.enabled)},ensure_ascii=False),encoding='utf-8')
            tmp.replace(self.file)

    def overlay(self, defaults, base, extra=(), skip=()):
        """Compute fresh values, never repeatedly add to the previous frame."""
        result = {}
        enabled = set(self.enabled)
        for name in extra:
            for group in EXCLUSIVE:
                if name in group:
                    enabled.difference_update(group)
        if any(name in GESTURES for name in extra):
            enabled.difference_update({'手机','蛋包饭','画笔','橡皮'})
        for row in self.catalog.parameters(list(dict.fromkeys(sorted(enabled)+list(extra)))):
            pid = row['Id']
            if pid in skip:
                continue
            value = result.get(pid,base.get(pid,defaults.get(pid,0.)))
            if row.get('Blend') == 'Multiply':
                value *= row['Value']
            elif row.get('Blend') == 'Overwrite':
                value = row['Value']
            else:
                value += row['Value']
            result[pid] = value
        return result

def menu_groups(catalog, controls):
    faces = [('face',None,'跟随陪看（自动）',controls.manual_face is None)]
    faces += [('face',name,LABELS.get(name,name),controls.manual_face==name) for name in catalog.faces]
    appearance = [('reset','appearance','恢复默认外观',False)]
    appearance += [('toggle',name,LABELS.get(name,name),name in controls.enabled) for name in catalog.appearance]
    props = [('reset','props','恢复默认道具',False)]
    props += [('toggle',name,LABELS.get(name,name),name in controls.enabled) for name in catalog.props]
    actions = [('stop',None,'停止动作／恢复待机',False)]
    actions += [('motion',key,row['label'],False) for key,row in catalog.motions.items()]
    actions += [('gesture',name,LABELS.get(name,name),False) for name in catalog.gestures]
    return [('表情',faces),('外观',appearance),('道具',props),('动作',actions)]
