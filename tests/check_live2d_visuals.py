from pathlib import Path
import sys
import json
from PIL import Image,ImageDraw,ImageFont
root = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'companion/desktop'))
from live2d_renderer import Live2DRenderer
renderer = Live2DRenderer()
controls = renderer.controls
previews = []
def capture(label,steps=25):
    for _ in range(steps):
        frame = renderer.frame('neutral',gaze=(200,180),dt=.04)
    assert frame.getbbox(),label
    previews.append((label,frame))
try:
    controls.toggle('深色桌布')
    controls.toggle('单边马尾')
    controls.toggle('圆眼镜')
    controls.set_face('脸红')
    capture('外观＋脸红')
    assert abs(renderer.model.GetParamValueById('cc2')-1)<.01
    capture('外观持续保留',80)
    assert abs(renderer.model.GetParamValueById('cc2')-1)<.01
    controls.set_face('星星眼')
    capture('外观＋星星眼')
    controls.reset('appearance')
    controls.set_face(None)
    capture('恢复默认')
    assert abs(renderer.model.GetParamValueById('cc2')-renderer.defaults['cc2'])<.01
    for name in ['手机','蛋包饭','鲸鱼','头箍','墨镜']:
        controls.reset('props')
        controls.reset('appearance')
        controls.toggle(name)
        capture(name)
    controls.reset('appearance')
    controls.reset('props')
    for key,definition in renderer.catalog.motions.items():
        renderer.play_motion(key)
        probe_ids = {'action-00':['chuipaopao','chuipaopao4'],'action-01':['pengshui'],'action-02':['phone2','phone4'],'action-03':['ji','danbaoX'],'action-04':['phone3','phone4'],'action-05':['phone3'],'action-06':['Param70','Param71']}[key]
        measured = {p:[] for p in probe_ids}
        for _ in range(max(1,int(definition['duration']/.04/3))):
            renderer.frame('neutral',dt=.04)
            for p in probe_ids:measured[p].append(renderer.model.GetParamValueById(p))
        capture(definition['label'],max(2,int(definition['duration']/.04/2)))
        for _ in range(int((definition['duration']+.5)/.04)):
            renderer.frame('neutral',gaze=(200,180),dt=.04)
        assert renderer.action is None,definition['label']+' failed to finish'
        assert any(max(v)-min(v)>.001 or abs(max(v)-renderer.defaults[p])>.001 for p,v in measured.items()),definition['label']+' has no animation parameter changes'
    for name in renderer.catalog.gestures:
        renderer.play_gesture(name)
        capture(name)
        for _ in range(85):renderer.frame('neutral',dt=.04)
        assert renderer.gesture is None,name
    sheet = Image.new('RGB',(400*4,480*((len(previews)+3)//4)),'#edf5fb')
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',17)
    for i,(label,frame) in enumerate(previews):
        x,y = i%4*400,i//4*480
        sheet.paste(frame,(x,y+32),frame)
        draw.text((x+15,y+8),label,font=font,fill='#264172')
    sheet.save(root/'data/live2d-visual-menu-preview.jpg')
    print(json.dumps({'outfitStable':True,'motionsCompleted':len(renderer.catalog.motions),'gesturesCompleted':len(renderer.catalog.gestures),'previewCases':len(previews)}))
finally:
    renderer.close()
