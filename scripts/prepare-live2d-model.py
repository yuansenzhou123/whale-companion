"""Build complete expression and one-shot motion indexes from the supplied archive."""
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MOTIONS = [('吹泡泡糖','motions/chuipaopao.motion3.json',[]),('鲸鱼喷水','motions/喷水.motion3.json',['鲸鱼']),('拿起手机','motions/开盖.motion3.json',[]),('挤番茄酱','motions/番茄酱.motion3.json',['蛋包饭']),('自拍','motions/自拍.motion3.json',[]),('快速自拍','motions/自拍简单.motion3.json',[]),('重锤出击','aidale.motion3.json',[])]

def prepare():
    source = ROOT/'live2D/DS鼠控版.zip'
    modeldir = ROOT/'live2D/runtime-mouse'
    output = modeldir/'whale-companion.model3.json'
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if output.exists():
        previous = json.loads(output.read_text(encoding='utf-8')).get('WhaleCompanion',{})
        if previous.get('schema') == 3 and previous.get('sourceSha256') == digest:
            print('Live2D expression and motion indexes ready.')
            return
    with zipfile.ZipFile(source) as archive:
        for row in archive.infolist():
            dest = (modeldir/row.filename).resolve()
            if not dest.is_relative_to(modeldir.resolve()):
                raise ValueError('Invalid path inside model archive')
            if not row.is_dir():
                dest.parent.mkdir(parents=True,exist_ok=True)
                dest.write_bytes(archive.read(row))
    model = json.loads((modeldir/'c_0120.model3.json').read_text(encoding='utf-8'))
    refs = model['FileReferences']
    refs['Expressions'] = []
    for i,expression in enumerate(sorted(modeldir.glob('*.exp3.json'))):
        relative = f'expressions/exp-{i:03d}.exp3.json'
        dest = modeldir/relative
        dest.parent.mkdir(exist_ok=True)
        shutil.copyfile(expression,dest)
        refs['Expressions'].append({'Name':expression.name.removesuffix('.exp3.json'),'File':relative})
    refs['Motions'] = {'Idle':[{'File':'motions/idle.motion3.json','FadeInTime':.6,'FadeOutTime':.6}],'Actions':[]}
    catalog = []
    for i,(label,name,requires) in enumerate(MOTIONS):
        motion = json.loads((modeldir/name).read_text(encoding='utf-8'))
        motion['Meta']['Loop'] = False
        relative = f'motions/runtime/action-{i:02d}.motion3.json'
        dest = modeldir/relative
        dest.parent.mkdir(exist_ok=True)
        dest.write_text(json.dumps(motion,ensure_ascii=False,indent=2),encoding='utf-8')
        refs['Motions']['Actions'].append({'File':relative,'FadeInTime':.15,'FadeOutTime':.2})
        catalog.append({'id':f'action-{i:02d}','label':label,'index':i,'duration':motion['Meta']['Duration'],'requires':requires,'parameters':[c['Id'] for c in motion.get('Curves',[]) if c['Target']=='Parameter']})
    model['WhaleCompanion'] = {'schema':3,'sourceSha256':digest,'motions':catalog}
    output.write_text(json.dumps(model,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Live2D ready:',len(refs['Expressions']),'visual options,',len(catalog),'one-shot motions')

if __name__ == '__main__':
    prepare()
